import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteActionPayload, NoteEntryPayload, NoteFolderPayload, NotesSnapshotPayload } from '../../shared/ipc'

interface NoteMetadata {
  id: string
  folderId: string | null
  title: string
  autoTitleGenerated?: boolean
  createdAt: number
  updatedAt: number
}

const FOLDERS_FILE_NAME = 'folders.json'
const NOTES_INDEX_FILE_NAME = 'notes-index.json'
const ACTIONS_FILE_NAME = 'actions.json'
const NOTE_FILES_DIRECTORY = 'entries'

const DEFAULT_NOTE_ACTION_ID = 'builtin-cleanup-notes'
const DEFAULT_NOTE_ACTION: NoteActionPayload = {
  id: DEFAULT_NOTE_ACTION_ID,
  name: 'Clean Up Notes',
  description: 'Fix grammar, structure, and formatting',
  instructions:
    'Clean up grammar, improve structure, and format these notes for readability while preserving all original meaning.',
  isBuiltIn: true,
  createdAt: 0,
  updatedAt: 0,
}

const parseJSONFile = <T>(filePath: string, fallback: T): T => {
  if (!existsSync(filePath)) {
    return fallback
  }

  try {
    const rawPayload = readFileSync(filePath, 'utf8')
    return JSON.parse(rawPayload) as T
  } catch {
    return fallback
  }
}

const sortFolders = (folders: NoteFolderPayload[]) => {
  return [...folders].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

const sortNotes = (notes: NoteEntryPayload[]) => {
  return [...notes].sort((left, right) => right.updatedAt - left.updatedAt)
}

const sortActions = (actions: NoteActionPayload[]) => {
  return [...actions].sort((left, right) => {
    if (left.isBuiltIn && !right.isBuiltIn) {
      return -1
    }

    if (!left.isBuiltIn && right.isBuiltIn) {
      return 1
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

const normalizeAction = (action: Partial<NoteActionPayload>): NoteActionPayload | null => {
  const id = action.id?.trim() ?? ''
  const name = action.name?.trim() ?? ''
  const instructions = action.instructions?.trim() ?? ''

  if (!id || !name || !instructions) {
    return null
  }

  return {
    id,
    name,
    description: action.description?.trim() ?? '',
    instructions,
    isBuiltIn: Boolean(action.isBuiltIn || id === DEFAULT_NOTE_ACTION_ID),
    createdAt: Number.isFinite(action.createdAt) ? Number(action.createdAt) : Date.now(),
    updatedAt: Number.isFinite(action.updatedAt) ? Number(action.updatedAt) : Date.now(),
  }
}

const ensureDefaultAction = (actions: NoteActionPayload[]) => {
  const normalized = actions
    .map((action) => normalizeAction(action))
    .filter((action): action is NoteActionPayload => action !== null)

  const deduplicated = normalized.filter(
    (action, index) => normalized.findIndex((candidate) => candidate.id === action.id) === index,
  )

  const withoutBuiltin = deduplicated.filter((action) => action.id !== DEFAULT_NOTE_ACTION_ID)
  return sortActions([DEFAULT_NOTE_ACTION, ...withoutBuiltin])
}

const sanitizeNoteFileToken = (noteId: string) => {
  const sanitized = noteId.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!sanitized) {
    return `note-${Date.now()}`
  }

  return sanitized
}

const createNoteTitleFileToken = (title: string) => {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const truncated = normalized.slice(0, 48)
  return truncated.length > 0 ? truncated : 'untitled'
}

export class NotesStore {
  constructor(private readonly notesRootDirectory: string) {
    this.ensureDirectoryLayout()
  }

  getSnapshot(): NotesSnapshotPayload {
    this.ensureDirectoryLayout()

    const foldersPath = this.resolveFoldersPath()
    const notesIndexPath = this.resolveNotesIndexPath()
    const actionsPath = this.resolveActionsPath()

    const folders = parseJSONFile<NoteFolderPayload[]>(foldersPath, [])
    const notesMetadata = parseJSONFile<NoteMetadata[]>(notesIndexPath, [])
    const actions = ensureDefaultAction(parseJSONFile<NoteActionPayload[]>(actionsPath, []))

    const notes = notesMetadata
      .map<NoteEntryPayload | null>((metadata) => {
        const id = typeof metadata.id === 'string' ? metadata.id.trim() : ''
        if (!id) {
          return null
        }

        const title = typeof metadata.title === 'string' && metadata.title.trim().length > 0 ? metadata.title : 'Untitled'

        return {
          id,
          folderId: typeof metadata.folderId === 'string' && metadata.folderId.trim().length > 0 ? metadata.folderId : null,
          title,
          autoTitleGenerated: Boolean(metadata.autoTitleGenerated),
          createdAt: Number.isFinite(metadata.createdAt) ? Number(metadata.createdAt) : Date.now(),
          updatedAt: Number.isFinite(metadata.updatedAt) ? Number(metadata.updatedAt) : Date.now(),
          rawText: this.readNoteText(id, title, 'raw'),
          processedText: this.readNoteText(id, title, 'processed'),
        }
      })
      .filter((note): note is NoteEntryPayload => note !== null)

    return {
      folders: sortFolders(folders),
      notes: sortNotes(notes),
      actions: sortActions(actions),
    }
  }

  setSnapshot(snapshot: NotesSnapshotPayload) {
    this.ensureDirectoryLayout()

    const folders = sortFolders(snapshot.folders)
    const notes = sortNotes(snapshot.notes)
    const actions = ensureDefaultAction(snapshot.actions)

    const notesMetadata: NoteMetadata[] = notes.map((note) => ({
      id: note.id,
      folderId: note.folderId,
      title: note.title,
      autoTitleGenerated: Boolean(note.autoTitleGenerated),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }))

    writeFileSync(this.resolveFoldersPath(), `${JSON.stringify(folders, null, 2)}\n`, 'utf8')
    writeFileSync(this.resolveNotesIndexPath(), `${JSON.stringify(notesMetadata, null, 2)}\n`, 'utf8')
    writeFileSync(this.resolveActionsPath(), `${JSON.stringify(actions, null, 2)}\n`, 'utf8')

    const expectedNoteFiles = new Set<string>()

    for (const note of notes) {
      const rawTextPath = this.resolveNoteTextPath(note.id, note.title, 'raw')
      const processedTextPath = this.resolveNoteTextPath(note.id, note.title, 'processed')

      writeFileSync(rawTextPath, note.rawText, 'utf8')
      writeFileSync(processedTextPath, note.processedText, 'utf8')

      expectedNoteFiles.add(rawTextPath)
      expectedNoteFiles.add(processedTextPath)
    }

    const noteFilesDirectory = this.resolveNoteFilesDirectory()
    for (const fileName of readdirSync(noteFilesDirectory)) {
      const filePath = join(noteFilesDirectory, fileName)
      if (!expectedNoteFiles.has(filePath)) {
        rmSync(filePath, { force: true })
      }
    }
  }

  private ensureDirectoryLayout() {
    mkdirSync(this.notesRootDirectory, { recursive: true })
    mkdirSync(this.resolveNoteFilesDirectory(), { recursive: true })
  }

  private resolveFoldersPath() {
    return join(this.notesRootDirectory, FOLDERS_FILE_NAME)
  }

  private resolveNotesIndexPath() {
    return join(this.notesRootDirectory, NOTES_INDEX_FILE_NAME)
  }

  private resolveActionsPath() {
    return join(this.notesRootDirectory, ACTIONS_FILE_NAME)
  }

  private resolveNoteFilesDirectory() {
    return join(this.notesRootDirectory, NOTE_FILES_DIRECTORY)
  }

  private resolveNoteTextPath(noteId: string, title: string, field: 'raw' | 'processed') {
    const safeToken = sanitizeNoteFileToken(noteId)
    const titleToken = createNoteTitleFileToken(title)
    return join(this.resolveNoteFilesDirectory(), `${safeToken}--${titleToken}.${field}.md`)
  }

  private resolveLegacyNoteTextPath(noteId: string, field: 'raw' | 'processed') {
    const safeToken = sanitizeNoteFileToken(noteId)
    return join(this.resolveNoteFilesDirectory(), `${safeToken}.${field}.txt`)
  }

  private resolveLegacyMarkdownNoteTextPath(noteId: string, field: 'raw' | 'processed') {
    const safeToken = sanitizeNoteFileToken(noteId)
    return join(this.resolveNoteFilesDirectory(), `${safeToken}.${field}.md`)
  }

  private resolveRenamedMarkdownCandidates(noteId: string, field: 'raw' | 'processed') {
    const safeToken = sanitizeNoteFileToken(noteId)
    const suffix = `.${field}.md`

    return readdirSync(this.resolveNoteFilesDirectory())
      .filter((fileName) => fileName.startsWith(`${safeToken}--`) && fileName.endsWith(suffix))
      .map((fileName) => join(this.resolveNoteFilesDirectory(), fileName))
  }

  private readNoteText(noteId: string, title: string, field: 'raw' | 'processed') {
    const filePath = this.resolveNoteTextPath(noteId, title, field)
    const legacyMarkdownPath = this.resolveLegacyMarkdownNoteTextPath(noteId, field)
    const legacyTextPath = this.resolveLegacyNoteTextPath(noteId, field)
    const renamedCandidates = this.resolveRenamedMarkdownCandidates(noteId, field)
    const resolvedPath = [filePath, legacyMarkdownPath, ...renamedCandidates, legacyTextPath].find((candidate) =>
      existsSync(candidate),
    )

    if (!resolvedPath) {
      return ''
    }

    try {
      return readFileSync(resolvedPath, 'utf8')
    } catch {
      return ''
    }
  }
}

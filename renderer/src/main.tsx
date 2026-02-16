import React, { Component, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { I18nProvider } from './i18n'
import { hydrateStorageFromBackend } from './lib/storage'
import './styles.css'

interface ErrorBoundaryState {
  hasError: boolean
  message: string
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message,
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-surface-0 p-6 text-foreground">
          <div className="max-w-xl rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1 p-5 text-sm">
            <p className="font-semibold">Renderer error</p>
            <p className="mt-2 text-muted-foreground">
              A renderer error occurred while drawing the UI. Message: {this.state.message}
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

const bootstrap = async () => {
  await hydrateStorageFromBackend()
  renderApp()
}

void bootstrap()

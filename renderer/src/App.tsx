import { useEffect, useMemo, useState } from 'react'
import { OverlayView } from './views/OverlayView'
import { ControlPanelView } from './views/ControlPanelView'

type AppRoute = 'overlay' | 'control'

const parseRoute = (): AppRoute => {
  const sanitized = window.location.hash.replace(/^#\/?/, '').toLowerCase()
  return sanitized === 'overlay' ? 'overlay' : 'control'
}

export const App = () => {
  const [route, setRoute] = useState<AppRoute>(parseRoute)

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseRoute())
    }

    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  const view = useMemo(() => {
    if (route === 'overlay') {
      return <OverlayView />
    }

    return <ControlPanelView />
  }, [route])

  useEffect(() => {
    document.body.dataset.view = route
  }, [route])

  return view
}

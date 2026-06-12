import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

type ServiceState = 'checking' | 'online' | 'offline'

type HealthResponse = {
  status: string
}

async function fetchHealthDetail() {
  const response = await fetch('/api/health', {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const payload = (await response.json()) as HealthResponse
  if (payload.status !== 'ok') {
    throw new Error('Unexpected response')
  }

  return 'HTTP 200'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}

function App() {
  const [serviceState, setServiceState] = useState<ServiceState>('checking')
  const [detail, setDetail] = useState('Waiting for response')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  const checkHealth = useCallback(async () => {
    setServiceState('checking')
    setDetail('Waiting for response')

    try {
      const result = await fetchHealthDetail()
      setServiceState('online')
      setDetail(result)
    } catch (error) {
      setServiceState('offline')
      setDetail(errorMessage(error))
    } finally {
      setCheckedAt(new Date())
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadHealth() {
      try {
        const result = await fetchHealthDetail()
        if (cancelled) {
          return
        }

        setServiceState('online')
        setDetail(result)
      } catch (error) {
        if (cancelled) {
          return
        }

        setServiceState('offline')
        setDetail(errorMessage(error))
      } finally {
        if (!cancelled) {
          setCheckedAt(new Date())
        }
      }
    }

    void loadHealth()

    return () => {
      cancelled = true
    }
  }, [])

  const statusLabel = useMemo(() => {
    switch (serviceState) {
      case 'online':
        return 'Online'
      case 'offline':
        return 'Offline'
      default:
        return 'Checking'
    }
  }, [serviceState])

  const checkedAtLabel = checkedAt
    ? new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(checkedAt)
    : 'Pending'

  return (
    <main className="shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          G
        </div>
        <div>
          <p className="eyebrow">Gorchestra</p>
          <h1>Service monitor</h1>
        </div>
      </header>

      <section className="status-panel" aria-label="Service status">
        <div className="status-row">
          <div>
            <p className="label">Backend</p>
            <h2>API health</h2>
          </div>
          <span className={`status-badge ${serviceState}`}>{statusLabel}</span>
        </div>

        <dl className="status-grid">
          <div>
            <dt>Endpoint</dt>
            <dd>/api/health</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd>{detail}</dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd>{checkedAtLabel}</dd>
          </div>
        </dl>

        <button type="button" onClick={() => void checkHealth()}>
          Refresh
        </button>
      </section>
    </main>
  )
}

export default App

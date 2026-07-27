import { Routes, Route } from 'react-router-dom'
import { SidebarLayout } from './components/sidebar-layout'
import { RequireAuth } from './components/RequireAuth'
import { RequireAdmin } from './components/RequireAdmin'
import { AppSidebar, AppNavbar } from './Sidebar'
import Dashboard from './pages/Dashboard'
import Recordings from './pages/Recordings'
import Journeys from './pages/Journeys'
import LiveTracking from './pages/LiveTracking'
import Reporting from './pages/Reporting'
import Settings from './pages/Settings'
import Privacy from './pages/Privacy'

function App() {
  return (
    <Routes>
      {/* Always public — required by Google OAuth verification, and must
          match the link configured on the consent screen exactly. Outside
          RequireAuth so it renders the same whether or not you're signed in. */}
      <Route path="/privacy" element={<Privacy />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <SidebarLayout navbar={<AppNavbar />} sidebar={<AppSidebar />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/recordings" element={<Recordings />} />
                <Route path="/journeys" element={<Journeys />} />
                <Route path="/live" element={<LiveTracking />} />
                <Route path="/reporting" element={<Reporting />} />
                <Route
                  path="/settings"
                  element={
                    <RequireAdmin>
                      <Settings />
                    </RequireAdmin>
                  }
                />
              </Routes>
            </SidebarLayout>
          </RequireAuth>
        }
      />
    </Routes>
  )
}

export default App

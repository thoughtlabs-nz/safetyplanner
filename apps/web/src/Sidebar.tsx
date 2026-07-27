import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { UserButton, useUser } from '@clerk/clerk-react'
import {
  HomeIcon,
  VideoCameraIcon,
  MapIcon,
  MapPinIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  SunIcon,
  MoonIcon,
} from '@heroicons/react/24/outline'
import {
  Sidebar as CatalystSidebar,
  SidebarHeader,
  SidebarBody,
  SidebarFooter,
  SidebarSection,
  SidebarItem,
  SidebarLabel,
} from './components/sidebar'
import { NavbarItem } from './components/navbar'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: HomeIcon },
  { href: '/recordings', label: 'Recordings', icon: VideoCameraIcon },
  { href: '/journeys', label: 'Journeys', icon: MapIcon },
  { href: '/live', label: 'Live', icon: MapPinIcon },
  { href: '/reporting', label: 'Reporting', icon: ChartBarIcon },
]

function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('theme', theme)
  }, [theme])

  return { theme, setTheme }
}

export function AppSidebar() {
  const location = useLocation()
  const { theme, setTheme } = useTheme()
  const { user } = useUser()
  const isAdmin = user?.publicMetadata?.role === 'admin'

  return (
    <CatalystSidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <img src="/logo.png" alt="Safety Planner" width={24} height={24} className="rounded" />
          <span className="text-sm font-semibold text-zinc-950 dark:text-white">Safety Planner</span>
        </div>
      </SidebarHeader>

      <SidebarBody>
        <SidebarSection>
          {NAV_ITEMS.map((item) => (
            <SidebarItem key={item.href} href={item.href} current={location.pathname === item.href}>
              <item.icon data-slot="icon" />
              <SidebarLabel>{item.label}</SidebarLabel>
            </SidebarItem>
          ))}
        </SidebarSection>
      </SidebarBody>

      <SidebarFooter>
        <SidebarSection>
          {isAdmin && (
            <SidebarItem href="/settings" current={location.pathname === '/settings'}>
              <Cog6ToothIcon data-slot="icon" />
              <SidebarLabel>Settings</SidebarLabel>
            </SidebarItem>
          )}
          <SidebarItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <SunIcon data-slot="icon" /> : <MoonIcon data-slot="icon" />}
            <SidebarLabel>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</SidebarLabel>
          </SidebarItem>
          <div className="flex items-center gap-2 px-2 py-1 text-zinc-950 dark:text-white">
            <UserButton afterSignOutUrl="/" />
            <SidebarLabel>Account</SidebarLabel>
          </div>
        </SidebarSection>
      </SidebarFooter>
    </CatalystSidebar>
  )
}

export function AppNavbar() {
  return (
    <NavbarItem href="/" aria-label="Safety Planner">
      <img src="/logo.png" alt="" width={20} height={20} className="rounded" />
    </NavbarItem>
  )
}

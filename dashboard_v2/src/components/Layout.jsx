import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { MessageSquare, BarChart2, Settings, LogOut, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { cn } from '../lib/utils';

export default function Layout() {
  const { logout } = useAuth();
  const { status } = useSocket();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-card flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <MessageSquare className="w-6 h-6 text-primary mr-3" />
          <span className="font-bold text-lg">ITSM NAC</span>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          <nav className="space-y-1 px-3">
            <NavLink
              to="/chat"
              className={({ isActive }) => cn(
                "flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors",
                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <MessageSquare className="w-5 h-5 mr-3" />
              Live Chat
            </NavLink>
            <NavLink
              to="/analytics"
              className={({ isActive }) => cn(
                "flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors opacity-50 cursor-not-allowed",
                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              onClick={(e) => e.preventDefault()}
            >
              <BarChart2 className="w-5 h-5 mr-3" />
              Analytics
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => cn(
                "flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors opacity-50 cursor-not-allowed",
                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              onClick={(e) => e.preventDefault()}
            >
              <Settings className="w-5 h-5 mr-3" />
              Settings
            </NavLink>
          </nav>
        </div>

        <div className="p-4 border-t border-border">
          <div className="flex items-center justify-between mb-4 px-2">
            <span className="text-sm text-muted-foreground">WA Status</span>
            <div className="flex items-center gap-1.5">
              {status === 'connected' ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className={cn(
                "text-xs font-medium capitalize",
                status === 'connected' ? "text-green-500" : "text-red-500"
              )}>
                {status}
              </span>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center w-full px-3 py-2 text-sm font-medium text-red-500 rounded-md hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-5 h-5 mr-3" />
            Logout
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

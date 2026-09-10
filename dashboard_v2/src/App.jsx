import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import LoginPage from './pages/LoginPage';
import LiveChatPage from './pages/LiveChatPage';
import Layout from './components/Layout';

const ProtectedRoute = ({ children }) => {
  const { user } = useAuth();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/chat" replace />} />
              <Route path="chat" element={<LiveChatPage />} />
              <Route path="chat/:jid" element={<LiveChatPage />} />
            </Route>
          </Routes>
        </Router>
      </SocketProvider>
    </AuthProvider>
  );
}

export default App;

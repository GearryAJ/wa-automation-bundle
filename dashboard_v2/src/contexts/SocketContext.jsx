import React, { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export function SocketProvider({ children }) {
  const { token } = useAuth();
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('disconnected');

  useEffect(() => {
    if (!token) return;

    const newSocket = io(window.location.origin, {
      auth: { token },
      path: '/socket.io',
    });

    setSocket(newSocket);

    newSocket.on('wa:status', (data) => {
      setStatus(data.status);
    });

    return () => newSocket.close();
  }, [token]);

  return (
    <SocketContext.Provider value={{ socket, status }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);

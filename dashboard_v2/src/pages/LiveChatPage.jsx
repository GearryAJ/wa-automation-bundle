import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import { Send, User, AlertCircle, MessageSquare } from 'lucide-react';

const safeFormat = (ts, fmt) => {
  try {
    if (!ts || isNaN(ts)) return '--:--';
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '--:--';
    return format(d, fmt);
  } catch (e) {
    return '--:--';
  }
};

export default function LiveChatPage() {
  const { jid } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const { socket } = useSocket();

  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [input, setInput] = useState('');
  const [loadingChats, setLoadingChats] = useState(true);
  
  const messagesEndRef = useRef(null);

  // Fetch Chat List
  useEffect(() => {
    const fetchChats = async () => {
      try {
        const res = await fetch('/api/chats', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setChats(data.sort((a, b) => b.lastUpdated - a.lastUpdated));
        }
      } catch (err) {
        console.error('Failed to fetch chats', err);
      } finally {
        setLoadingChats(false);
      }
    };
    fetchChats();
  }, [token]);

  // Fetch Messages & Tickets when JID changes
  useEffect(() => {
    if (!jid) return;
    
    const fetchChatDetails = async () => {
      try {
        const msgRes = await fetch(`/api/chats/${jid}/messages`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (msgRes.ok) {
          const msgData = await msgRes.json();
          // Normalize JSONL log fields → frontend format
          const normalized = msgData.map(m => ({
            jid: m.jid,
            sender: m.sender,
            chatName: m.chat_name,
            senderName: m.sender_name,
            fromMe: m.from_me,
            text: m.text,
            type: m.type,
            timestamp: m.ts,
            mediaUrl: m.media_url,
          }));
          setMessages(normalized);
        }

        const tktRes = await fetch(`/api/chats/${jid}/tickets`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (tktRes.ok) {
          const tktData = await tktRes.json();
          setTickets(tktData.tickets || []);
        }
      } catch (err) {
        console.error('Failed to fetch messages', err);
      }
    };
    fetchChatDetails();
  }, [jid, token]);

  // Listen for realtime events
  useEffect(() => {
    if (!socket) return;

    const handleMessageReceived = (msg) => {
      if (msg.jid === jid) {
        setMessages(prev => [...prev, msg]);
      }
      
      // Update chat list
      setChats(prev => {
        const chatIdx = prev.findIndex(c => c.jid === msg.jid);
        if (chatIdx >= 0) {
          const newChats = [...prev];
          newChats[chatIdx] = { 
            ...newChats[chatIdx], 
            lastUpdated: msg.timestamp,
            chatName: msg.chatName || newChats[chatIdx].chatName
          };
          return newChats.sort((a, b) => b.lastUpdated - a.lastUpdated);
        } else {
          return [{
            jid: msg.jid,
            chatName: msg.chatName,
            lastUpdated: msg.timestamp
          }, ...prev].sort((a, b) => b.lastUpdated - a.lastUpdated);
        }
      });
    };

    const handleMessageSent = (msg) => {
      if (msg.jid === jid) {
        setMessages(prev => [...prev, msg]);
      }
    };

    socket.on('message:received', handleMessageReceived);
    socket.on('message:sent', handleMessageSent);

    return () => {
      socket.off('message:received', handleMessageReceived);
      socket.off('message:sent', handleMessageSent);
    };
  }, [socket, jid]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || !jid) return;

    const text = input;
    setInput('');
    try {
      await fetch(`/api/chats/${jid}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ text })
      });
    } catch (err) {
      console.error('Failed to send message', err);
    }
  };

  const selectedChat = chats.find(c => c.jid === jid);

  return (
    <div className="flex h-full w-full">
      {/* Chat List */}
      <div className="w-80 border-r border-border bg-card flex flex-col h-full">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Conversations</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingChats ? (
            <div className="p-4 text-center text-muted-foreground text-sm">Loading...</div>
          ) : chats.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">No conversations found</div>
          ) : (
            chats.map((chat) => (
              <div
                key={chat.jid}
                onClick={() => navigate(`/chat/${chat.jid}`)}
                className={cn(
                  "p-4 border-b border-border cursor-pointer transition-colors hover:bg-muted",
                  jid === chat.jid ? "bg-muted" : ""
                )}
              >
                <div className="flex justify-between items-start mb-1">
                  <div className="font-medium truncate flex-1 pr-2">
                    {chat.chatName || chat.jid.split('@')[0]}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {safeFormat(chat.lastUpdated, 'HH:mm')}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {chat.jid.split('@')[0]}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Window */}
      {jid ? (
        <div className="flex-1 flex flex-col bg-background h-full min-w-0">
          {/* Header */}
          <div className="h-16 flex items-center px-6 border-b border-border bg-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
                <User className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">
                  {selectedChat?.chatName || jid.split('@')[0]}
                </h3>
                <span className="text-xs text-muted-foreground">{jid.split('@')[0]}</span>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {messages.map((msg, idx) => {
              const isOperator = msg.fromMe;
              const isBot = msg.senderName === 'ITSM NAC BNI' && msg.text?.includes('Pengecekan otomatis') || msg.text?.includes('Mohon ditunggu');
              
              return (
                <div
                  key={idx}
                  className={cn(
                    "flex flex-col max-w-[70%]",
                    isOperator ? "ml-auto items-end" : "items-start"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1 px-1">
                    <span className="text-xs text-muted-foreground font-medium">
                      {isOperator ? (isBot ? 'Bot (AI)' : 'You (Operator)') : msg.chatName || msg.sender}
                    </span>
                    <span className="text-xs text-muted-foreground/60">
                      {safeFormat(msg.timestamp, 'HH:mm')}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "px-4 py-2.5 rounded-2xl whitespace-pre-wrap text-sm shadow-sm",
                      isOperator 
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted text-foreground rounded-tl-sm border border-border"
                    )}
                  >
                    {msg.type === 'image' && msg.mediaUrl && (
                      <div className="mb-2">
                        <img src={msg.mediaUrl} alt="Received Media" className="max-w-[250px] sm:max-w-xs rounded-xl object-contain border border-black/10" />
                      </div>
                    )}
                    {msg.type === 'document' && msg.mediaUrl && (
                      <div className="mb-2">
                        <a href={msg.mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 p-2 rounded-lg text-sm font-medium bg-black/5 hover:bg-black/10 transition-colors border border-black/5">
                          📄 Unduh Dokumen
                        </a>
                      </div>
                    )}
                    {msg.text && (
                      <div className={cn((msg.type === 'image' || msg.type === 'document') && msg.mediaUrl && "mt-1")}>
                        {msg.text.startsWith('[Gambar]') ? msg.text.replace('[Gambar]', '').trim() || '[Gambar Tanpa Caption]' : msg.text}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-4 bg-card border-t border-border">
            <form onSubmit={handleSend} className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 bg-background border border-border rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="bg-primary text-primary-foreground w-11 h-11 rounded-full flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center bg-background h-full text-muted-foreground">
          <MessageSquare className="w-16 h-16 mb-4 opacity-20" />
          <p>Select a conversation to start chatting</p>
        </div>
      )}

      {/* Side Panel (Context/Tickets) */}
      {jid && (
        <div className="w-80 border-l border-border bg-card flex flex-col h-full">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold">User Context</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">
                Recent Tickets
              </h3>
              {tickets.length > 0 ? (
                <div className="space-y-3">
                  {tickets.map((ticket, i) => (
                    <div key={i} className="bg-background border border-border rounded-lg p-3 text-sm">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-semibold text-primary">{ticket.id || `TKT-${Math.floor(Math.random()*1000)}`}</span>
                        <span className="text-xs text-muted-foreground">
                          {ticket.date || 'Recent'}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-xs line-clamp-2">
                        {ticket.problem_desc || 'No description provided'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
                  <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
                  <span className="text-sm">No tickets found</span>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">
                Extracted Data
              </h3>
              <div className="bg-background border border-border rounded-lg p-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">NPP:</span>
                  <span className="font-medium">-</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">IP/MAC:</span>
                  <span className="font-medium">-</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

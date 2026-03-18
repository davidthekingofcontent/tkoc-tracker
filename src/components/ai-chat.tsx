'use client'

import { useState, useRef, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import {
  MessageCircle,
  X,
  Send,
  Loader2,
  Sparkles,
  Bot,
  User,
  Minimize2,
  Maximize2,
} from 'lucide-react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

function formatMarkdown(text: string) {
  // Simple markdown-to-html: bold, italic, code, lists, headers
  let html = text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-gray-800 text-green-300 p-3 rounded-lg text-xs my-2 overflow-x-auto"><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 text-purple-700 px-1.5 py-0.5 rounded text-xs">$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="font-bold text-sm mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="font-bold text-lg mt-3 mb-1">$1</h2>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    .replace(/^• (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-sm">$1</li>')
    // Line breaks
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br/>')

  return `<p>${html}</p>`
}

const SUGGESTIONS = {
  en: [
    'What are the key learnings from our campaigns?',
    'Which influencers have the best engagement?',
    'Suggest improvements for our tracking strategy',
    'Analyze the performance of our latest content',
  ],
  es: [
    'Cuales son los aprendizajes de nuestras campanas?',
    'Que influencers tienen mejor engagement?',
    'Sugiere mejoras para nuestra estrategia',
    'Analiza el rendimiento del contenido reciente',
  ],
}

export function AIChatWidget() {
  const { t, locale } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  async function handleSend(text?: string) {
    const messageText = (text || input).trim()
    if (!messageText || isLoading) return

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)
    setError('')

    try {
      const allMessages = [...messages, userMessage].map(m => ({
        role: m.role,
        content: m.content,
      }))

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: allMessages }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Error communicating with AI')
        return
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.message,
        timestamp: new Date(),
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch {
      setError('Connection error')
    } finally {
      setIsLoading(false)
    }
  }

  const suggestions = SUGGESTIONS[locale as keyof typeof SUGGESTIONS] || SUGGESTIONS.en

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/30 transition-all hover:scale-105 hover:shadow-xl hover:shadow-purple-500/40"
        title="TKOC AI"
      >
        <Sparkles className="h-6 w-6" />
      </button>
    )
  }

  return (
    <div
      className={`fixed z-50 flex flex-col bg-white shadow-2xl shadow-gray-400/30 border border-gray-200 transition-all duration-300 ${
        isExpanded
          ? 'inset-4 rounded-2xl'
          : 'bottom-6 right-6 w-[420px] h-[600px] rounded-2xl'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-2xl bg-gradient-to-r from-purple-600 to-indigo-600 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">TKOC AI</h3>
            <p className="text-xs text-white/70">
              {locale === 'es' ? 'Asistente inteligente' : 'Smart assistant'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
          >
            {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="space-y-4">
            {/* Welcome */}
            <div className="text-center py-6">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-100 to-indigo-100 mb-3">
                <Bot className="h-8 w-8 text-purple-600" />
              </div>
              <h4 className="text-base font-bold text-gray-900">
                {locale === 'es' ? 'Hola! Soy TKOC AI' : 'Hi! I\'m TKOC AI'}
              </h4>
              <p className="text-sm text-gray-500 mt-1 max-w-[280px] mx-auto">
                {locale === 'es'
                  ? 'Puedo analizar tus campanas, dar insights sobre influencers y ayudarte a mejorar tu estrategia.'
                  : 'I can analyze your campaigns, provide influencer insights, and help improve your strategy.'
                }
              </p>
            </div>

            {/* Suggestions */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-400 uppercase px-1">
                {locale === 'es' ? 'Prueba preguntando:' : 'Try asking:'}
              </p>
              {suggestions.map((suggestion, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(suggestion)}
                  className="w-full text-left rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 transition-colors hover:bg-purple-50 hover:border-purple-200 hover:text-purple-700"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 mt-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-purple-100 to-indigo-100">
                  <Bot className="h-4 w-4 text-purple-600" />
                </div>
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-purple-600 text-white rounded-br-md'
                  : 'bg-gray-100 text-gray-800 rounded-bl-md'
              }`}
            >
              {msg.role === 'assistant' ? (
                <div
                  className="prose prose-sm max-w-none [&_p]:my-0 [&_li]:my-0.5 [&_h2]:text-gray-900 [&_h3]:text-gray-900 [&_h4]:text-gray-900 [&_strong]:text-gray-900"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.content) }}
                />
              ) : (
                <span>{msg.content}</span>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 mt-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-200">
                  <User className="h-4 w-4 text-gray-600" />
                </div>
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-2.5">
            <div className="flex-shrink-0 mt-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-purple-100 to-indigo-100">
                <Bot className="h-4 w-4 text-purple-600" />
              </div>
            </div>
            <div className="rounded-2xl rounded-bl-md bg-gray-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                <span className="text-sm text-gray-500">
                  {locale === 'es' ? 'Pensando...' : 'Thinking...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={locale === 'es' ? 'Pregunta lo que quieras...' : 'Ask anything...'}
            disabled={isLoading}
            className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-purple-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-600 text-white transition-colors hover:bg-purple-700 disabled:opacity-50 disabled:pointer-events-none"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

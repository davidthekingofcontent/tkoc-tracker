'use client'

import { useState, useRef, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import {
  X,
  Send,
  Loader2,
  Sparkles,
  Bot,
  User,
  Minimize2,
  Maximize2,
  RotateCcw,
} from 'lucide-react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

/** Request/response contract with /api/ai/chat */
interface ChatApiRequest {
  messages: { role: 'user' | 'assistant'; content: string }[]
  locale: string
}
interface ChatApiResponse {
  message?: string
  model?: string
  truncated?: boolean
  error?: string
  code?: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMarkdown(text: string) {
  // Escape first so model output can never inject markup, then apply a
  // small markdown subset: code, bold, italic, headers, lists, paragraphs.
  const html = escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-gray-800 text-green-300 p-3 rounded-lg text-xs my-2 overflow-x-auto"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="bg-gray-200 dark:bg-gray-700 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded text-xs">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/^### (.+)$/gm, '<h4 class="font-bold text-sm mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="font-bold text-lg mt-3 mb-1">$1</h2>')
    .replace(/^\s*[-•] (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    .replace(/^\s*\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-sm">$1</li>')
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br/>')

  return `<p>${html}</p>`
}

const SUGGESTIONS = {
  en: [
    'How do I create a campaign and add creators?',
    'Why is no content showing up in my campaign?',
    'How do I connect the brand\'s Instagram (Meta)?',
    'How do I give a client read-only portal access?',
    'Which campaign is performing best right now?',
  ],
  es: [
    '¿Cómo creo una campaña y añado creadores?',
    '¿Por qué no aparece contenido en mi campaña?',
    '¿Cómo conecto el Instagram de la marca (Meta)?',
    '¿Cómo doy acceso de solo lectura a un cliente?',
    '¿Qué campaña está funcionando mejor ahora mismo?',
  ],
}

const ALLOWED_ROLES = new Set(['ADMIN', 'EMPLOYEE'])

export function AIChatWidget() {
  const { locale } = useI18n()
  const isEs = locale === 'es'
  const [isOpen, setIsOpen] = useState(false)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch user role on mount
  useEffect(() => {
    async function fetchRole() {
      try {
        const res = await fetch('/api/auth/me')
        if (res.ok) {
          const data = await res.json()
          setUserRole(data.user?.role || null)
        }
      } catch {
        setUserRole(null)
      }
    }
    fetchRole()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

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

    const history = [...messages, userMessage]
    setMessages(history)
    setInput('')
    setIsLoading(true)
    setError('')

    try {
      const payload: ChatApiRequest = {
        messages: history.map(m => ({ role: m.role, content: m.content })),
        locale,
      }

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      let data: ChatApiResponse = {}
      try {
        data = (await res.json()) as ChatApiResponse
      } catch {
        // Non-JSON body (e.g. a proxy/timeout page)
      }

      if (!res.ok || !data.message) {
        setError(
          data.error ||
            (isEs
              ? `Error del servidor (${res.status}). Inténtalo de nuevo.`
              : `Server error (${res.status}). Please try again.`)
        )
        return
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.truncated
          ? `${data.message}\n\n_${isEs ? '(respuesta recortada por longitud)' : '(response truncated by length)'}_`
          : data.message,
        timestamp: new Date(),
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch {
      setError(isEs ? 'No se ha podido conectar con el servidor.' : 'Could not reach the server.')
    } finally {
      setIsLoading(false)
    }
  }

  function handleReset() {
    setMessages([])
    setError('')
    setInput('')
    inputRef.current?.focus()
  }

  // Agency staff only (the API enforces the same rule).
  if (!userRole || !ALLOWED_ROLES.has(userRole)) {
    return null
  }

  const suggestions = SUGGESTIONS[locale as keyof typeof SUGGESTIONS] || SUGGESTIONS.en

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/30 transition-all hover:scale-105 hover:shadow-xl hover:shadow-purple-500/40"
        title="TKOC AI"
        aria-label="TKOC AI"
      >
        <Sparkles className="h-6 w-6" />
      </button>
    )
  }

  return (
    <div
      className={`fixed z-50 flex flex-col bg-white dark:bg-gray-900 shadow-2xl shadow-gray-400/30 dark:shadow-black/40 border border-gray-200 dark:border-gray-700 transition-all duration-300 ${
        isExpanded
          ? 'inset-4 rounded-2xl'
          : 'bottom-6 right-6 w-[420px] max-w-[calc(100vw-3rem)] h-[600px] max-h-[calc(100vh-3rem)] rounded-2xl'
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
              {isEs ? 'Asistente de la plataforma' : 'Platform assistant'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={handleReset}
              className="rounded-lg p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
              title={isEs ? 'Nueva conversación' : 'New conversation'}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            title={isExpanded ? (isEs ? 'Reducir' : 'Minimize') : (isEs ? 'Ampliar' : 'Expand')}
          >
            {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            title={isEs ? 'Cerrar' : 'Close'}
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
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-100 to-indigo-100 dark:from-purple-900/40 dark:to-indigo-900/40 mb-3">
                <Bot className="h-8 w-8 text-purple-600 dark:text-purple-300" />
              </div>
              <h4 className="text-base font-bold text-gray-900 dark:text-gray-100">
                {isEs ? '¡Hola! Soy TKOC AI' : 'Hi! I\'m TKOC AI'}
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-[300px] mx-auto">
                {isEs
                  ? 'Te explico paso a paso cómo usar la plataforma (campañas, captura de contenido, Meta, portal de cliente, pricing) y analizo los datos de tus campañas.'
                  : 'I walk you through the platform step by step (campaigns, content capture, Meta, client portal, pricing) and analyze your campaign data.'}
              </p>
            </div>

            {/* Suggestions */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase px-1">
                {isEs ? 'Prueba preguntando:' : 'Try asking:'}
              </p>
              {suggestions.map((suggestion, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(suggestion)}
                  className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 transition-colors hover:bg-purple-50 dark:hover:bg-purple-900/30 hover:border-purple-200 dark:hover:border-purple-700 hover:text-purple-700 dark:hover:text-purple-200"
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
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-purple-100 to-indigo-100 dark:from-purple-900/40 dark:to-indigo-900/40">
                  <Bot className="h-4 w-4 text-purple-600 dark:text-purple-300" />
                </div>
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-purple-600 text-white rounded-br-md'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100 rounded-bl-md'
              }`}
            >
              {msg.role === 'assistant' ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-0 [&_li]:my-0.5 [&_h2]:text-gray-900 dark:[&_h2]:text-gray-100 [&_h3]:text-gray-900 dark:[&_h3]:text-gray-100 [&_h4]:text-gray-900 dark:[&_h4]:text-gray-100 [&_strong]:text-gray-900 dark:[&_strong]:text-gray-100"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.content) }}
                />
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 mt-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
                  <User className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                </div>
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-2.5">
            <div className="flex-shrink-0 mt-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-purple-100 to-indigo-100 dark:from-purple-900/40 dark:to-indigo-900/40">
                <Bot className="h-4 w-4 text-purple-600 dark:text-purple-300" />
              </div>
            </div>
            <div className="rounded-2xl rounded-bl-md bg-gray-100 dark:bg-gray-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {isEs ? 'Pensando...' : 'Thinking...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={isEs ? 'Pregunta cómo hacer algo en la plataforma...' : 'Ask how to do something in the platform...'}
            disabled={isLoading}
            className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:bg-white dark:focus:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-600 text-white transition-colors hover:bg-purple-700 disabled:opacity-50 disabled:pointer-events-none"
            title={isEs ? 'Enviar' : 'Send'}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

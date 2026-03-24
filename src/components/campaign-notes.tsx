'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { MessageSquare, Send, Loader2, X } from 'lucide-react'

interface Note {
  id: string
  userName: string
  text: string
  createdAt: string
}

interface CampaignNotesProps {
  campaignId: string
  influencerId: string
  locale: string
  readOnly?: boolean
}

export function CampaignNotesButton({ campaignId, influencerId, locale, readOnly }: CampaignNotesProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [newNote, setNewNote] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)

  useEffect(() => {
    if (isOpen) {
      fetchNotes()
    }
  }, [isOpen, campaignId, influencerId])

  async function fetchNotes() {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/notes?influencerId=${influencerId}`)
      if (res.ok) {
        const data = await res.json()
        setNotes(data.notes || [])
      }
    } catch { /* ignore */ }
    setIsLoading(false)
  }

  async function handleSend() {
    if (!newNote.trim()) return
    setIsSending(true)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId, text: newNote.trim() }),
      })
      if (res.ok) {
        setNewNote('')
        await fetchNotes()
      }
    } catch { /* ignore */ }
    setIsSending(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-all ${
          isOpen
            ? 'border-purple-300 bg-purple-50 text-purple-700'
            : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-700'
        }`}
      >
        <MessageSquare className="h-3 w-3" />
        {locale === 'es' ? 'Notas' : 'Notes'}
        {notes.length > 0 && (
          <span className="ml-0.5 rounded-full bg-purple-600 px-1.5 py-0 text-[10px] text-white font-bold">
            {notes.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-8 z-30 w-80 rounded-xl border border-gray-200 bg-white shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="text-xs font-semibold text-gray-700">
              <MessageSquare className="mr-1 inline h-3 w-3" />
              {locale === 'es' ? 'Notas del equipo' : 'Team Notes'}
            </span>
            <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Notes list */}
          <div className="max-h-60 overflow-y-auto p-3 space-y-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              </div>
            ) : notes.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-400">
                {locale === 'es' ? 'Sin notas todavía' : 'No notes yet'}
              </p>
            ) : (
              notes.map((note) => (
                <div key={note.id} className="rounded-lg bg-gray-50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-purple-600">{note.userName}</span>
                    <span className="text-[10px] text-gray-400">
                      {new Date(note.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-700">{note.text}</p>
                </div>
              ))
            )}
          </div>

          {/* Input */}
          {!readOnly && (
          <div className="border-t border-gray-100 p-2">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={locale === 'es' ? 'Escribe una nota...' : 'Write a note...'}
                className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none placeholder:text-gray-400 focus:border-purple-400 focus:ring-1 focus:ring-purple-400"
              />
              <button
                onClick={handleSend}
                disabled={isSending || !newNote.trim()}
                className="rounded-lg bg-purple-600 p-1.5 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {isSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              </button>
            </div>
          </div>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { useState, useEffect, useCallback } from 'react'
import { MessageSquare, Send, Loader2 } from 'lucide-react'
import { Modal, ModalHeader, ModalBody } from '@/components/ui/modal'

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
  /** Shown in the dialog title so the PM knows whose notes these are. */
  influencerLabel?: string
}

/**
 * Team notes about one creator inside a campaign.
 *
 * The notes used to open as an absolutely-positioned popover inside the
 * creator card; the card clips its overflow, so the popover (and its input)
 * was cut off and the PM could not type (David, 2026-09-14). It is now a
 * centered modal with a real textarea: nothing to clip, works on mobile.
 */
export function CampaignNotesButton({ campaignId, influencerId, locale, readOnly, influencerLabel }: CampaignNotesProps) {
  const es = locale === 'es'
  const [isOpen, setIsOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchNotes = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/notes?influencerId=${influencerId}`)
      if (res.ok) {
        const data = await res.json()
        setNotes(Array.isArray(data.notes) ? data.notes : [])
        setLoaded(true)
      } else {
        setError(es ? 'No se pudieron cargar las notas' : 'Notes could not be loaded')
      }
    } catch {
      setError(es ? 'No se pudieron cargar las notas' : 'Notes could not be loaded')
    }
    setIsLoading(false)
  }, [campaignId, influencerId, es])

  useEffect(() => {
    if (isOpen) void fetchNotes()
  }, [isOpen, fetchNotes])

  async function handleSend() {
    const text = newNote.trim()
    if (!text || isSending) return
    setIsSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId, text }),
      })
      if (res.ok) {
        setNewNote('')
        await fetchNotes()
      } else {
        setError(es ? 'No se pudo guardar la nota' : 'The note could not be saved')
      }
    } catch {
      setError(es ? 'No se pudo guardar la nota' : 'The note could not be saved')
    }
    setIsSending(false)
  }

  const count = loaded ? notes.length : null

  return (
    <>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setIsOpen(true) }}
        title={es ? 'Notas del equipo sobre este creador' : 'Team notes about this creator'}
        className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500 transition-all hover:border-gray-300 hover:text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <MessageSquare className="h-3 w-3" />
        {es ? 'Notas' : 'Notes'}
        {count !== null && count > 0 && (
          <span className="ml-0.5 rounded-full bg-purple-600 px-1.5 py-0 text-[10px] font-bold text-white">{count}</span>
        )}
      </button>

      <Modal open={isOpen} onClose={() => setIsOpen(false)} className="max-w-lg">
        <ModalHeader onClose={() => setIsOpen(false)}>
          <span className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-purple-600" />
            {es ? 'Notas del equipo' : 'Team notes'}
            {influencerLabel && <span className="text-sm font-normal text-gray-500">· {influencerLabel}</span>}
          </span>
        </ModalHeader>
        <ModalBody>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {isLoading && !loaded ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              </div>
            ) : notes.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">{es ? 'Sin notas todavía' : 'No notes yet'}</p>
            ) : (
              notes.map(note => (
                <div key={note.id} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-purple-600 dark:text-purple-400">{note.userName}</span>
                    <span className="text-[11px] text-gray-400">
                      {new Date(note.createdAt).toLocaleString(es ? 'es-ES' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{note.text}</p>
                </div>
              ))
            )}
          </div>

          {!readOnly && (
            <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                {es ? 'Nueva nota' : 'New note'}
              </label>
              <textarea
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
                rows={3}
                maxLength={2000}
                placeholder={es ? 'Escribe una nota para el equipo… (Enter envía, Mayús+Enter salta de línea)' : 'Write a note for the team… (Enter sends, Shift+Enter for a new line)'}
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-purple-400 focus:ring-1 focus:ring-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-red-600">{error}</span>
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={isSending || !newNote.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
                >
                  {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {es ? 'Guardar nota' : 'Save note'}
                </button>
              </div>
            </div>
          )}
          {readOnly && error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        </ModalBody>
      </Modal>
    </>
  )
}

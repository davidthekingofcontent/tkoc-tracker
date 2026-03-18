'use client'

import { useState, useEffect } from 'react'
import { Modal, ModalHeader, ModalBody } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  FolderPlus,
  ListPlus,
  Plus,
} from 'lucide-react'

interface AddToModalProps {
  open: boolean
  onClose: () => void
  influencerId: string
  influencerName: string
}

interface ListItem {
  id: string
  name: string
  _count: { items: number }
}

interface CampaignItem {
  id: string
  name: string
  status: string
  _count: { influencers: number; media: number }
}

export function AddToModal({ open, onClose, influencerId, influencerName }: AddToModalProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'campaign' | 'list'>('campaign')
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([])
  const [lists, setLists] = useState<ListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [actionResult, setActionResult] = useState<{
    type: 'success' | 'error'
    message: string
    targetId?: string
  } | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [newListName, setNewListName] = useState('')
  const [creatingList, setCreatingList] = useState(false)

  useEffect(() => {
    if (open) {
      setActionResult(null)
      fetchData()
    }
  }, [open])

  async function fetchData() {
    setIsLoading(true)
    try {
      const [campaignsRes, listsRes] = await Promise.all([
        fetch('/api/campaigns?status=ACTIVE'),
        fetch('/api/lists'),
      ])
      if (campaignsRes.ok) {
        const data = await campaignsRes.json()
        setCampaigns(data.campaigns || [])
      }
      if (listsRes.ok) {
        const data = await listsRes.json()
        setLists(data.lists || [])
      }
    } catch {
      // Ignore
    } finally {
      setIsLoading(false)
    }
  }

  async function handleAddToCampaign(campaignId: string) {
    setAddingTo(campaignId)
    setActionResult(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/influencers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId }),
      })
      const data = await res.json()
      if (res.ok) {
        setActionResult({ type: 'success', message: t.campaignDetail.addedSuccess, targetId: campaignId })
      } else if (res.status === 409) {
        setActionResult({ type: 'error', message: t.campaignDetail.alreadyAdded, targetId: campaignId })
      } else {
        setActionResult({ type: 'error', message: data.error || 'Error', targetId: campaignId })
      }
    } catch {
      setActionResult({ type: 'error', message: 'Network error', targetId: campaignId })
    } finally {
      setAddingTo(null)
    }
  }

  async function handleAddToList(listId: string) {
    setAddingTo(listId)
    setActionResult(null)
    try {
      const res = await fetch(`/api/lists/${listId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId }),
      })
      const data = await res.json()
      if (res.ok) {
        setActionResult({ type: 'success', message: t.campaignDetail.addedSuccess, targetId: listId })
      } else if (res.status === 409) {
        setActionResult({ type: 'error', message: t.campaignDetail.alreadyAdded, targetId: listId })
      } else {
        setActionResult({ type: 'error', message: data.error || 'Error', targetId: listId })
      }
    } catch {
      setActionResult({ type: 'error', message: 'Network error', targetId: listId })
    } finally {
      setAddingTo(null)
    }
  }

  async function handleCreateList() {
    if (!newListName.trim()) return
    setCreatingList(true)
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newListName.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        setLists(prev => [data.list, ...prev])
        setNewListName('')
        // Auto-add influencer to the new list
        await handleAddToList(data.list.id)
      }
    } catch {
      // Ignore
    } finally {
      setCreatingList(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader onClose={onClose}>
        {t.common.add} — {influencerName}
      </ModalHeader>
      <ModalBody className="p-0">
        {/* Tab switcher */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => { setTab('campaign'); setActionResult(null) }}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              tab === 'campaign'
                ? 'border-b-2 border-purple-600 text-purple-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <FolderPlus className="mr-2 inline h-4 w-4" />
            {t.campaignDetail.addToCampaign}
          </button>
          <button
            onClick={() => { setTab('list'); setActionResult(null) }}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              tab === 'list'
                ? 'border-b-2 border-purple-600 text-purple-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <ListPlus className="mr-2 inline h-4 w-4" />
            {t.campaignDetail.addToList}
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
            </div>
          ) : tab === 'campaign' ? (
            <div className="space-y-2">
              {campaigns.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">{t.campaigns.noCampaigns}</p>
              ) : (
                campaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 transition-colors hover:bg-gray-50"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{campaign.name}</p>
                      <p className="text-xs text-gray-500">
                        {campaign._count.influencers} {t.dashboard.influencers} · {campaign._count.media} {t.dashboard.media}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {actionResult?.targetId === campaign.id && (
                        actionResult.type === 'success' ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <span className="text-xs text-red-500">{actionResult.message}</span>
                        )
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleAddToCampaign(campaign.id)}
                        disabled={addingTo === campaign.id || (actionResult?.targetId === campaign.id && actionResult.type === 'success')}
                      >
                        {addingTo === campaign.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : actionResult?.targetId === campaign.id && actionResult.type === 'success' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        {t.common.add}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {/* Create new list inline */}
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 py-3">
                <input
                  type="text"
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder={t.lists.listNamePlaceholder}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreateList}
                  disabled={creatingList || !newListName.trim()}
                >
                  {creatingList ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  {t.common.create}
                </Button>
              </div>

              {lists.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-500">{t.lists.noLists}</p>
              ) : (
                lists.map((list) => (
                  <div
                    key={list.id}
                    className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 transition-colors hover:bg-gray-50"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{list.name}</p>
                      <p className="text-xs text-gray-500">
                        {list._count.items} {t.lists.creators}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {actionResult?.targetId === list.id && (
                        actionResult.type === 'success' ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <span className="text-xs text-red-500">{actionResult.message}</span>
                        )
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleAddToList(list.id)}
                        disabled={addingTo === list.id || (actionResult?.targetId === list.id && actionResult.type === 'success')}
                      >
                        {addingTo === list.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : actionResult?.targetId === list.id && actionResult.type === 'success' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        {t.common.add}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </ModalBody>
    </Modal>
  )
}

'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ListChecks, Pin, Archive, Search, Users, Eye, Plus, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ui/stat-card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatNumber, formatDate } from '@/lib/utils'
import { useI18n } from '@/i18n/context'

interface ListData {
  id: string
  name: string
  isPinned: boolean
  isArchived: boolean
  createdAt: string
  totalReach: number
  _count: { items: number }
}

export default function ListsPage() {
  const { t } = useI18n()
  const [lists, setLists] = useState<ListData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  async function fetchLists() {
    try {
      const res = await fetch('/api/lists')
      if (res.ok) {
        const data = await res.json()
        setLists(data.lists || [])
      }
    } catch (err) {
      console.error('Error fetching lists:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchLists()
  }, [])

  const activeLists = lists.filter((l) => !l.isArchived)
  const totalInfluencers = lists.reduce((sum, l) => sum + (l._count?.items || 0), 0)
  const combinedReach = lists.reduce((sum, l) => sum + (l.totalReach || 0), 0)

  const filteredLists = (filter: 'all' | 'pinned' | 'archived') => {
    let result = lists
    if (filter === 'pinned') result = lists.filter((l) => l.isPinned)
    if (filter === 'archived') result = lists.filter((l) => l.isArchived)
    if (filter === 'all') result = lists.filter((l) => !l.isArchived)
    if (search) {
      result = result.filter((l) =>
        l.name.toLowerCase().includes(search.toLowerCase())
      )
    }
    return result
  }

  const handleCreateList = async () => {
    if (!newListName.trim()) return
    setIsCreating(true)
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newListName.trim() }),
      })
      if (res.ok) {
        setNewListName('')
        setShowCreateModal(false)
        fetchLists()
      }
    } catch (err) {
      console.error('Error creating list:', err)
    } finally {
      setIsCreating(false)
    }
  }

  const handleTogglePin = async (list: ListData) => {
    try {
      const res = await fetch(`/api/lists/${list.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: !list.isPinned }),
      })
      if (res.ok) fetchLists()
    } catch (err) {
      console.error('Error toggling pin:', err)
    }
  }

  const handleToggleArchive = async (list: ListData) => {
    try {
      const res = await fetch(`/api/lists/${list.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isArchived: !list.isArchived }),
      })
      if (res.ok) fetchLists()
    } catch (err) {
      console.error('Error toggling archive:', err)
    }
  }

  const handleDeleteList = async (listId: string) => {
    try {
      const res = await fetch(`/api/lists/${listId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setDeleteConfirm(null)
        fetchLists()
      }
    } catch (err) {
      console.error('Error deleting list:', err)
    }
  }

  const renderTable = (items: ListData[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t.lists.listName}</TableHead>
          <TableHead>{t.lists.creators}</TableHead>
          <TableHead>{t.common.status}</TableHead>
          <TableHead>{t.lists.reach}</TableHead>
          <TableHead className="text-right">{t.common.actions}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="py-12 text-center text-gray-500">
              {t.lists.noLists}
            </TableCell>
          </TableRow>
        ) : (
          items.map((list) => (
            <TableRow key={list.id}>
              <TableCell>
                <Link
                  href={`/lists/${list.id}`}
                  className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600 transition-colors"
                >
                  {list.isPinned ? '📌 ' : ''}{list.name}
                </Link>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-gray-400" />
                  {list._count?.items || 0}
                </span>
              </TableCell>
              <TableCell>{formatDate(list.createdAt)}</TableCell>
              <TableCell>{formatNumber(list.totalReach || 0)}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => handleTogglePin(list)}
                    className={`rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
                      list.isPinned ? 'text-purple-600' : 'text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                    title={list.isPinned ? 'Unpin' : 'Pin'}
                  >
                    <Pin className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleToggleArchive(list)}
                    className={`rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
                      list.isArchived ? 'text-purple-600' : 'text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                    title={list.isArchived ? 'Unarchive' : 'Archive'}
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(list.id)}
                    className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.lists.title}</h1>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="h-4 w-4" />
          {t.lists.createList}
        </Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label={t.lists.title}
          value={activeLists.length}
          accent
        />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={t.lists.creators}
          value={formatNumber(totalInfluencers)}
        />
        <StatCard
          icon={<Eye className="h-5 w-5" />}
          label={t.lists.reach}
          value={formatNumber(combinedReach)}
        />
      </div>

      {/* Search */}
      <Input
        placeholder={t.contacts.searchPlaceholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        icon={<Search className="h-4 w-4" />}
      />

      {/* Tabs & Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
          <span className="ml-2 text-gray-500">{t.common.loading}</span>
        </div>
      ) : (
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">{t.campaigns.all}</TabsTrigger>
            <TabsTrigger value="pinned">{t.lists.pinned}</TabsTrigger>
            <TabsTrigger value="archived">{t.common.archived}</TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
              {renderTable(filteredLists('all'))}
            </div>
          </TabsContent>
          <TabsContent value="pinned">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
              {renderTable(filteredLists('pinned'))}
            </div>
          </TabsContent>
          <TabsContent value="archived">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
              {renderTable(filteredLists('archived'))}
            </div>
          </TabsContent>
        </Tabs>
      )}

      {/* Delete Confirmation Modal */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)}>
        <ModalHeader onClose={() => setDeleteConfirm(null)}>
          {t.common.confirm || 'Confirm Delete'}
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t.lists.deleteConfirm || 'Are you sure you want to delete this list? This action cannot be undone.'}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
            {t.common.cancel}
          </Button>
          <Button
            variant="primary"
            onClick={() => deleteConfirm && handleDeleteList(deleteConfirm)}
            className="bg-red-600 hover:bg-red-700"
          >
            {t.common.delete || 'Delete'}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Create List Modal */}
      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)}>
        <ModalHeader onClose={() => setShowCreateModal(false)}>
          {t.lists.createList}
        </ModalHeader>
        <ModalBody>
          <Input
            label={t.lists.listName}
            placeholder={t.lists.listNamePlaceholder}
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setShowCreateModal(false)}>
            {t.common.cancel}
          </Button>
          <Button onClick={handleCreateList} disabled={!newListName.trim() || isCreating}>
            {isCreating ? t.common.loading : t.common.create}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}

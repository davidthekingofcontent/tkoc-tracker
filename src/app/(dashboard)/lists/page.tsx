'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ListChecks, Pin, Archive, Search, Users, Eye, Plus, Loader2 } from 'lucide-react'
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
  const [lists, setLists] = useState<ListData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

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

  const renderTable = (items: ListData[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>List Name</TableHead>
          <TableHead>Profiles</TableHead>
          <TableHead>Date Created</TableHead>
          <TableHead>Total Reach</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="py-12 text-center text-gray-500">
              No lists found
            </TableCell>
          </TableRow>
        ) : (
          items.map((list) => (
            <TableRow key={list.id}>
              <TableCell>
                <Link
                  href={`/lists/${list.id}`}
                  className="font-medium text-gray-900 hover:text-purple-600 transition-colors"
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
                    className={`rounded-lg p-2 transition-colors hover:bg-gray-100 ${
                      list.isPinned ? 'text-purple-600' : 'text-gray-400 hover:text-gray-900'
                    }`}
                    title={list.isPinned ? 'Unpin' : 'Pin'}
                  >
                    <Pin className="h-4 w-4" />
                  </button>
                  <button
                    className={`rounded-lg p-2 transition-colors hover:bg-gray-100 ${
                      list.isArchived ? 'text-purple-600' : 'text-gray-400 hover:text-gray-900'
                    }`}
                    title={list.isArchived ? 'Unarchive' : 'Archive'}
                  >
                    <Archive className="h-4 w-4" />
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
        <h1 className="text-2xl font-bold text-gray-900">Lists</h1>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="h-4 w-4" />
          Create new List
        </Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label="Active Lists"
          value={activeLists.length}
          accent
        />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Total Influencers"
          value={formatNumber(totalInfluencers)}
        />
        <StatCard
          icon={<Eye className="h-5 w-5" />}
          label="Combined Reach"
          value={formatNumber(combinedReach)}
        />
      </div>

      {/* Search */}
      <Input
        placeholder="Search lists..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        icon={<Search className="h-4 w-4" />}
      />

      {/* Tabs & Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 rounded-xl border border-gray-200 bg-white">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
          <span className="ml-2 text-gray-500">Loading lists...</span>
        </div>
      ) : (
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="pinned">Pinned</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              {renderTable(filteredLists('all'))}
            </div>
          </TabsContent>
          <TabsContent value="pinned">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              {renderTable(filteredLists('pinned'))}
            </div>
          </TabsContent>
          <TabsContent value="archived">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              {renderTable(filteredLists('archived'))}
            </div>
          </TabsContent>
        </Tabs>
      )}

      {/* Create List Modal */}
      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)}>
        <ModalHeader onClose={() => setShowCreateModal(false)}>
          Create New List
        </ModalHeader>
        <ModalBody>
          <Input
            label="List Name"
            placeholder="e.g. Summer Campaign Creators"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setShowCreateModal(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreateList} disabled={!newListName.trim() || isCreating}>
            {isCreating ? 'Creating...' : 'Create List'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}

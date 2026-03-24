"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n/context"
import { useRole } from "@/hooks/use-role"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Building2,
  Plus,
  Search,
  Loader2,
  Globe,
  Users,
  Megaphone,
  Settings,
  X,
  ChevronRight,
  AlertCircle,
} from "lucide-react"

interface Brand {
  id: string
  name: string
  logo?: string
  website?: string
  assignedEmployees: Array<{ id: string; name: string }>
  campaignCount: number
  brandUserId?: string
  createdBy: string
  createdAt: string
}

interface TeamMember {
  id: string
  name: string
  email: string
  role: string
}

export default function BrandsPage() {
  const { locale } = useI18n()
  const { role, isAdmin, canEdit } = useRole()

  const [brands, setBrands] = useState<Brand[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState("")

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newWebsite, setNewWebsite] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState("")

  // Manage employees modal
  const [managingBrand, setManagingBrand] = useState<Brand | null>(null)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([])
  const [brandUserId, setBrandUserId] = useState("")
  const [saving, setSaving] = useState(false)

  const labels = useMemo(() => {
    if (locale === "es") {
      return {
        title: "Marcas",
        subtitle: "Gestiona las marcas/clientes y sus campañas",
        createBrand: "Crear Marca",
        searchPlaceholder: "Buscar marca...",
        noBrands: "Sin marcas todavía",
        noBrandsDesc: "Crea tu primera marca para empezar a organizar tus campañas por cliente.",
        campaigns: "campañas",
        employees: "empleados asignados",
        website: "Sitio web",
        viewCampaigns: "Ver campañas",
        manageEmployees: "Gestionar Empleados",
        deleteBrand: "Eliminar",
        createTitle: "Crear Nueva Marca",
        brandName: "Nombre de la marca",
        brandNamePlaceholder: "Ej: Nike, Coca-Cola...",
        brandWebsite: "Sitio web (opcional)",
        brandWebsitePlaceholder: "https://example.com",
        cancel: "Cancelar",
        create: "Crear",
        creating: "Creando...",
        manageTitle: "Gestionar Empleados",
        assignedEmployees: "Empleados Asignados",
        brandUser: "Usuario Marca (solo lectura)",
        brandUserDesc: "Vincula un usuario BRAND para ver resultados",
        save: "Guardar",
        saving: "Guardando...",
        none: "Ninguno",
        deleteConfirm: "¿Seguro que quieres eliminar esta marca? Esta acción no se puede deshacer.",
        createdBy: "Creado por",
      }
    }
    return {
      title: "Brands",
      subtitle: "Manage brands/clients and their campaigns",
      createBrand: "Create Brand",
      searchPlaceholder: "Search brands...",
      noBrands: "No brands yet",
      noBrandsDesc: "Create your first brand to start organizing campaigns by client.",
      campaigns: "campaigns",
      employees: "assigned employees",
      website: "Website",
      viewCampaigns: "View campaigns",
      manageEmployees: "Manage Employees",
      deleteBrand: "Delete",
      createTitle: "Create New Brand",
      brandName: "Brand name",
      brandNamePlaceholder: "e.g. Nike, Coca-Cola...",
      brandWebsite: "Website (optional)",
      brandWebsitePlaceholder: "https://example.com",
      cancel: "Cancel",
      create: "Create",
      creating: "Creating...",
      manageTitle: "Manage Employees",
      assignedEmployees: "Assigned Employees",
      brandUser: "Brand User (read-only)",
      brandUserDesc: "Link a BRAND role user to view results",
      save: "Save",
      saving: "Saving...",
      none: "None",
      deleteConfirm: "Are you sure you want to delete this brand? This action cannot be undone.",
      createdBy: "Created by",
    }
  }, [locale])

  const fetchBrands = useCallback(async () => {
    try {
      const res = await fetch("/api/brands")
      if (res.ok) {
        const data = await res.json()
        setBrands(data.brands || [])
      }
    } catch (err) {
      console.error("Error fetching brands:", err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBrands()
  }, [fetchBrands])

  const filteredBrands = useMemo(() => {
    if (!search) return brands
    const q = search.toLowerCase()
    return brands.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.website?.toLowerCase().includes(q)
    )
  }, [brands, search])

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setCreateError("")
    try {
      const res = await fetch("/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          website: newWebsite.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to create brand")
      }
      setShowCreate(false)
      setNewName("")
      setNewWebsite("")
      fetchBrands()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (brandId: string) => {
    if (!confirm(labels.deleteConfirm)) return
    try {
      await fetch(`/api/brands?brandId=${brandId}`, { method: "DELETE" })
      fetchBrands()
    } catch {
      // ignore
    }
  }

  const openManage = async (brand: Brand) => {
    setManagingBrand(brand)
    setSelectedEmployees(brand.assignedEmployees.map((e) => e.id))
    setBrandUserId(brand.brandUserId || "")

    if (teamMembers.length === 0) {
      setTeamLoading(true)
      try {
        const res = await fetch("/api/team")
        if (res.ok) {
          const data = await res.json()
          setTeamMembers(data.members || [])
        }
      } catch {
        // ignore
      } finally {
        setTeamLoading(false)
      }
    }
  }

  const handleSaveManage = async () => {
    if (!managingBrand) return
    setSaving(true)
    try {
      await fetch("/api/brands", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId: managingBrand.id,
          assignedEmployees: selectedEmployees,
          brandUserId: brandUserId || undefined,
        }),
      })
      setManagingBrand(null)
      fetchBrands()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const toggleEmployee = (id: string) => {
    setSelectedEmployees((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {labels.title}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {labels.subtitle}
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            {labels.createBrand}
          </Button>
        )}
      </div>

      {/* Search */}
      {brands.length > 0 && (
        <div className="w-full sm:w-72">
          <Input
            placeholder={labels.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search className="h-4 w-4" />}
          />
        </div>
      )}

      {/* Brand Grid */}
      {filteredBrands.length === 0 ? (
        <Card variant="elevated" className="dark:bg-gray-800 dark:border-gray-700">
          <CardContent>
            <div className="py-12 text-center">
              <Building2 className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
              <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
                {labels.noBrands}
              </h3>
              <p className="mt-2 text-gray-500 dark:text-gray-400">
                {labels.noBrandsDesc}
              </p>
              {canEdit && (
                <Button
                  className="mt-4"
                  onClick={() => setShowCreate(true)}
                >
                  <Plus className="h-4 w-4" />
                  {labels.createBrand}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredBrands.map((brand) => (
            <Card
              key={brand.id}
              variant="elevated"
              className="dark:bg-gray-800 dark:border-gray-700 hover:shadow-lg transition-shadow"
            >
              <CardContent>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-purple-100 dark:bg-purple-900/40">
                      <Building2 className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
                        {brand.name}
                      </h3>
                      {brand.website && (
                        <a
                          href={brand.website.startsWith("http") ? brand.website : `https://${brand.website}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors"
                        >
                          <Globe className="h-3 w-3" />
                          <span className="truncate">{brand.website.replace(/^https?:\/\//, '')}</span>
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                {/* Stats row */}
                <div className="mt-4 flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                    <Megaphone className="h-3.5 w-3.5" />
                    <span>{brand.campaignCount} {labels.campaigns}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                    <Users className="h-3.5 w-3.5" />
                    <span>{brand.assignedEmployees.length} {labels.employees}</span>
                  </div>
                </div>

                {/* Assigned employees badges */}
                {brand.assignedEmployees.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {brand.assignedEmployees.slice(0, 3).map((emp) => (
                      <span
                        key={emp.id}
                        className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-300"
                      >
                        {emp.name}
                      </span>
                    ))}
                    {brand.assignedEmployees.length > 3 && (
                      <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                        +{brand.assignedEmployees.length - 3}
                      </span>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="mt-4 flex items-center gap-2 border-t border-gray-100 dark:border-gray-700 pt-3">
                  <Link
                    href={`/campaigns?brand=${brand.id}`}
                    className="flex items-center gap-1 text-xs font-medium text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    {labels.viewCampaigns}
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => openManage(brand)}
                        className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        <Settings className="h-3 w-3" />
                        {labels.manageEmployees}
                      </button>
                      <button
                        onClick={() => handleDelete(brand.id)}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      >
                        {labels.deleteBrand}
                      </button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Brand Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {labels.createTitle}
              </h2>
              <button
                onClick={() => { setShowCreate(false); setCreateError("") }}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {labels.brandName}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={labels.brandNamePlaceholder}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 bg-white dark:bg-gray-700"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate() }}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {labels.brandWebsite}
                </label>
                <input
                  type="text"
                  value={newWebsite}
                  onChange={(e) => setNewWebsite(e.target.value)}
                  placeholder={labels.brandWebsitePlaceholder}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 bg-white dark:bg-gray-700"
                />
              </div>

              {createError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {createError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="ghost" onClick={() => { setShowCreate(false); setCreateError("") }}>
                  {labels.cancel}
                </Button>
                <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
                  {creating ? labels.creating : labels.create}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manage Employees Modal */}
      {managingBrand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {labels.manageTitle}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">{managingBrand.name}</p>
              </div>
              <button
                onClick={() => setManagingBrand(null)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {labels.assignedEmployees}
                </label>
                {teamLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {teamMembers
                      .filter((m) => m.role === "ADMIN" || m.role === "EMPLOYEE")
                      .map((member) => (
                        <label
                          key={member.id}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors",
                            selectedEmployees.includes(member.id)
                              ? "border-purple-300 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-700"
                              : "border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selectedEmployees.includes(member.id)}
                            onChange={() => toggleEmployee(member.id)}
                            className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {member.name}
                            </p>
                            <p className="text-xs text-gray-400 truncate">{member.email}</p>
                          </div>
                          <span className="ml-auto text-[10px] font-medium text-gray-400 uppercase">
                            {member.role}
                          </span>
                        </label>
                      ))}
                  </div>
                )}
              </div>

              {/* Brand user link */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {labels.brandUser}
                </label>
                <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">
                  {labels.brandUserDesc}
                </p>
                <select
                  value={brandUserId}
                  onChange={(e) => setBrandUserId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                >
                  <option value="">{labels.none}</option>
                  {teamMembers
                    .filter((m) => m.role === "BRAND")
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} ({member.email})
                      </option>
                    ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="ghost" onClick={() => setManagingBrand(null)}>
                  {labels.cancel}
                </Button>
                <Button onClick={handleSaveManage} disabled={saving}>
                  {saving ? labels.saving : labels.save}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

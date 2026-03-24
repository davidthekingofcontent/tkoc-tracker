import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// Helper: get assigned employee IDs for a brand
async function getAssignedEmployees(brandUserId: string): Promise<string[]> {
  const setting = await prisma.setting.findUnique({
    where: { key: `brand_assignment_${brandUserId}` },
  })
  if (!setting) return []
  try {
    return JSON.parse(setting.value) as string[]
  } catch {
    return []
  }
}

// GET: Return all brand-employee assignments
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Get all brand users
    const brandUsers = await prisma.user.findMany({
      where: { role: 'BRAND', isActive: true },
      select: { id: true, name: true, email: true },
    })

    // Get all employees
    const employees = await prisma.user.findMany({
      where: { role: { in: ['EMPLOYEE', 'ADMIN'] }, isActive: true },
      select: { id: true, name: true, email: true },
    })

    // Get assignments for each brand
    const assignments = await Promise.all(
      brandUsers.map(async (brand) => {
        const employeeIds = await getAssignedEmployees(brand.id)
        return {
          brandId: brand.id,
          brandName: brand.name,
          brandEmail: brand.email,
          employees: employees.filter((e) => employeeIds.includes(e.id)),
        }
      })
    )

    return NextResponse.json({ assignments, allEmployees: employees })
  } catch (error) {
    console.error('Brand assignments GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST: Assign an employee to a brand
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { brandId, employeeId } = await request.json()
    if (!brandId || !employeeId) {
      return NextResponse.json({ error: 'brandId and employeeId are required' }, { status: 400 })
    }

    const key = `brand_assignment_${brandId}`
    const existing = await getAssignedEmployees(brandId)

    if (existing.includes(employeeId)) {
      return NextResponse.json({ message: 'Already assigned' })
    }

    const updated = [...existing, employeeId]

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(updated) },
      update: { value: JSON.stringify(updated) },
    })

    return NextResponse.json({ message: 'Employee assigned to brand', employeeIds: updated })
  } catch (error) {
    console.error('Brand assignments POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE: Remove an employee from a brand
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { brandId, employeeId } = await request.json()
    if (!brandId || !employeeId) {
      return NextResponse.json({ error: 'brandId and employeeId are required' }, { status: 400 })
    }

    const key = `brand_assignment_${brandId}`
    const existing = await getAssignedEmployees(brandId)
    const updated = existing.filter((id) => id !== employeeId)

    if (updated.length === 0) {
      // Remove the setting entirely if no employees assigned
      await prisma.setting.deleteMany({ where: { key } })
    } else {
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(updated) },
        update: { value: JSON.stringify(updated) },
      })
    }

    return NextResponse.json({ message: 'Employee removed from brand', employeeIds: updated })
  } catch (error) {
    console.error('Brand assignments DELETE error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

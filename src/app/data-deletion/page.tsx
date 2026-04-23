import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Data Deletion — TKOC Intelligence',
}

interface Props {
  searchParams: Promise<{ id?: string }>
}

export default async function DataDeletionPage({ searchParams }: Props) {
  const { id } = await searchParams
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <div className="rounded-2xl border border-gray-200 bg-white p-10 shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-6 text-2xl font-bold text-gray-900">Data Deletion Request Received</h1>
        <p className="mt-3 text-gray-600">
          Your request to delete your data from TKOC Intelligence has been received and is being processed.
        </p>
        <p className="mt-4 text-sm text-gray-500">
          All personal data, social media tokens (Meta / Instagram Business, YouTube), cached content and
          audience insights, and associated campaign data will be permanently deleted within 30 days.
          You will receive a confirmation email once the deletion is complete.
        </p>
        {id && (
          <div className="mt-6 rounded-lg border border-purple-200 bg-purple-50 p-4">
            <p className="text-xs uppercase tracking-wide text-purple-600">Confirmation code</p>
            <p className="mt-1 font-mono text-sm text-purple-900 break-all">{id}</p>
            <p className="mt-2 text-xs text-purple-700">
              Reference this code if you need to follow up about this deletion request.
            </p>
          </div>
        )}
        <div className="mt-8 rounded-lg bg-gray-50 p-4">
          <p className="text-xs text-gray-500">
            If you have questions about your data deletion request, contact us at:
          </p>
          <p className="mt-1 text-sm font-medium text-gray-700">admon@thekingofcontent.agency</p>
        </div>
        <div className="mt-6">
          <a href="/" className="text-sm text-purple-600 hover:underline">Return to TKOC Intelligence</a>
        </div>
      </div>
    </div>
  )
}

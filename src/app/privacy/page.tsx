import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — TKOC Intelligence',
}

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-6 flex items-center justify-end gap-2 text-sm">
        <span className="font-medium text-purple-700 border-b-2 border-purple-700 pb-0.5">English</span>
        <span className="text-gray-300">|</span>
        <a href="/privacy/es" className="text-gray-500 hover:text-purple-600">Español</a>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: March 23, 2026</p>

      <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">1. Introduction</h2>
          <p>
            TKOC Intelligence (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is an influencer marketing intelligence platform
            operated by DAMA Platforms S.L. (&quot;TKOC&quot;). This Privacy Policy describes how we collect,
            use, store, and protect personal data when you use our platform at tkoc-tracker-production.up.railway.app
            (the &quot;Service&quot;).
          </p>
          <p>
            We are committed to protecting your privacy and complying with the General Data Protection
            Regulation (GDPR), the Spanish Organic Law on Data Protection (LOPDGDD), and all applicable
            data protection laws.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">2. Data Controller</h2>
          <p>
            DAMA Platforms S.L.<br />
            CIF: B56551146<br />
            C/ Sector Pueblos 23, 5B — 28760 Tres Cantos, Madrid, Spain<br />
            Email: admon@thekingofcontent.agency
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">3. Data We Collect</h2>
          <h3 className="text-lg font-medium text-gray-800 mt-4">3.1 Account Data</h3>
          <p>When you register or are invited to the platform, we collect:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Name and email address</li>
            <li>Password (encrypted with bcrypt, never stored in plaintext)</li>
            <li>Role assignment (Admin, Employee, or Brand)</li>
          </ul>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.2 Social Media Data (via Meta/Instagram API)</h3>
          <p>When you connect your Instagram account or authorize access, we may collect:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Instagram Business/Creator account profile information (username, bio, profile picture, follower count)</li>
            <li>Media content metadata (post URLs, captions, engagement metrics such as likes, comments, views, shares, saves)</li>
            <li>Audience insights (aggregate demographics — age ranges, gender distribution, geographic regions)</li>
            <li>Content performance data (reach, impressions, engagement rates)</li>
          </ul>
          <p>
            <strong>We do NOT collect:</strong> private messages, payment information from social platforms,
            personal contact lists, or any data from non-business/non-creator accounts.
          </p>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.3 YouTube Data (via YouTube Data API)</h3>
          <p>We access publicly available YouTube data including:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Channel information (name, subscriber count, description)</li>
            <li>Video metadata (titles, views, likes, comments, publish dates)</li>
          </ul>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.4 Campaign Data</h3>
          <p>Data generated through platform use:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Campaign configurations (names, dates, tracked hashtags and accounts)</li>
            <li>Influencer collaboration details (fees, status, content delivery)</li>
            <li>Performance analytics and reports</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">4. How We Use Your Data</h2>
          <p>We use collected data exclusively for:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Campaign Management:</strong> tracking influencer content performance for authorized campaigns</li>
            <li><strong>Analytics & Reporting:</strong> generating performance reports (EMV, engagement rates, CPM analysis)</li>
            <li><strong>Intelligence Features:</strong> Creator Score calculations, Deal Advisor pricing analysis, Risk Signal detection</li>
            <li><strong>Platform Operation:</strong> user authentication, notifications, and platform functionality</li>
          </ul>
          <p>
            We do <strong>not</strong> sell, rent, or share personal data with third parties for marketing purposes.
            We do <strong>not</strong> use data for advertising targeting or profiling beyond the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">5. Legal Basis for Processing</h2>
          <p>Under GDPR, we process data based on:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Consent:</strong> When you connect a social media account or authorize data access</li>
            <li><strong>Contract:</strong> To provide the Service as agreed</li>
            <li><strong>Legitimate Interest:</strong> For platform security, fraud prevention, and service improvement</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">6. Data Sharing</h2>
          <p>We may share data with:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Meta Platforms, Inc.:</strong> As required by Instagram/Facebook API terms</li>
            <li><strong>Google LLC:</strong> As required by YouTube API terms</li>
            <li><strong>Infrastructure Providers:</strong> Railway (hosting), PostgreSQL (database) — under data processing agreements</li>
          </ul>
          <p>We do not share data with any other third parties.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">7. Data Retention</h2>
          <p>
            We retain account data for the duration of your account. Campaign data is retained while the
            campaign exists. When a campaign is deleted, all associated data (media, influencer assignments,
            notes, files) is permanently and irreversibly deleted via cascading deletion.
          </p>
          <p>
            You may request deletion of your account and all associated data at any time by contacting
            admon@thekingofcontent.agency or using the data deletion endpoint.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">8. Your Rights (GDPR)</h2>
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Access:</strong> Request a copy of your personal data</li>
            <li><strong>Rectification:</strong> Correct inaccurate data</li>
            <li><strong>Erasure:</strong> Request deletion of your data (&quot;right to be forgotten&quot;)</li>
            <li><strong>Restriction:</strong> Limit how we process your data</li>
            <li><strong>Portability:</strong> Receive your data in a machine-readable format</li>
            <li><strong>Object:</strong> Object to data processing based on legitimate interest</li>
            <li><strong>Withdraw Consent:</strong> Revoke any previously given consent at any time</li>
          </ul>
          <p>To exercise these rights, contact: admon@thekingofcontent.agency</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">9. Data Security</h2>
          <p>We implement appropriate security measures including:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Encrypted passwords (bcrypt hashing)</li>
            <li>Encrypted API tokens and secrets (AES-256-GCM)</li>
            <li>HTTPS-only communication</li>
            <li>Role-based access control (Admin, Employee, Brand)</li>
            <li>Secure session management with JWT tokens</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">10. Data Deletion</h2>
          <p>
            To request deletion of all your data, you can:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Email admon@thekingofcontent.agency</li>
            <li>Use the automated data deletion endpoint at /api/data-deletion</li>
            <li>Disconnect your social media accounts from Settings</li>
          </ul>
          <p>
            Upon receiving a valid deletion request, we will delete all personal data within 30 days
            and confirm the deletion.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">11. Cookies</h2>
          <p>
            We use only essential cookies required for authentication and session management.
            We do not use tracking cookies, analytics cookies, or advertising cookies.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">12. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify users of significant
            changes via email or in-app notification. Continued use of the Service after changes
            constitutes acceptance of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">13. Contact</h2>
          <p>
            For questions about this Privacy Policy or data protection:<br />
            DAMA Platforms S.L.<br />
            CIF: B56551146<br />
            C/ Sector Pueblos 23, 5B — 28760 Tres Cantos, Madrid, Spain<br />
            Email: admon@thekingofcontent.agency
          </p>
        </section>
      </div>
    </div>
  )
}

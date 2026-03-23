import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service — TKOC Intelligence',
}

export default function TermsOfServicePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: March 23, 2026</p>

      <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">1. Acceptance of Terms</h2>
          <p>
            By accessing or using TKOC Intelligence (&quot;the Service&quot;), operated by The King of Content S.L.
            (&quot;TKOC&quot;, &quot;we&quot;, &quot;our&quot;), you agree to be bound by these Terms of Service.
            If you do not agree to these terms, you may not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">2. Description of Service</h2>
          <p>
            TKOC Intelligence is an influencer marketing intelligence platform that helps brands and agencies
            manage campaigns, track content performance, analyze influencer metrics, and generate insights
            for data-driven decision making. The Service integrates with social media platforms including
            Instagram (via Meta Graph API) and YouTube (via YouTube Data API) to provide analytics
            and reporting capabilities.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">3. User Accounts</h2>
          <p>
            Access to the Service requires an invitation from an authorized administrator. By creating
            an account, you agree to:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Provide accurate and complete registration information</li>
            <li>Maintain the confidentiality of your login credentials</li>
            <li>Accept responsibility for all activities under your account</li>
            <li>Notify us immediately of any unauthorized use of your account</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">4. User Roles and Permissions</h2>
          <p>The Service provides three user roles with different access levels:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Admin:</strong> Full access to all features, settings, integrations, and user management</li>
            <li><strong>Employee:</strong> Access to campaigns, influencer management, and reporting features</li>
            <li><strong>Brand:</strong> Read-only access to campaigns assigned to them, with limited editing capabilities</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">5. Social Media Integration</h2>
          <p>
            When you connect social media accounts (Instagram, YouTube) to the Service, you authorize
            us to access your public profile data and content metrics as described in our Privacy Policy.
            You may disconnect your accounts at any time through the Settings page.
          </p>
          <p>
            You represent that you have the authority to connect any accounts you link to the Service
            and that doing so does not violate any agreements with the respective platforms.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">6. Creator and Influencer Invitations</h2>
          <p>
            The Service allows authorized users to invite creators and influencers to connect their
            social media profiles. By accepting an invitation and connecting your profile, you consent
            to the collection and processing of your public profile data and content metrics as described
            in our Privacy Policy. You may revoke this consent at any time.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">7. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Use the Service to violate any laws or regulations</li>
            <li>Access data or accounts not authorized for your role</li>
            <li>Attempt to circumvent security measures</li>
            <li>Share login credentials with unauthorized parties</li>
            <li>Use the Service to harass, defame, or harm any individual</li>
            <li>Reverse-engineer or attempt to extract the source code of the Service</li>
            <li>Use the Service in violation of any social media platform&apos;s terms of service</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">8. Intellectual Property</h2>
          <p>
            The Service, including its design, code, algorithms (Creator Score, Deal Advisor, Risk Signals,
            Campaign Intelligence, Repeat Radar), and branding, is the intellectual property of
            The King of Content S.L. All rights reserved.
          </p>
          <p>
            Campaign data and reports generated by users remain the property of the respective users
            and their organizations.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">9. Data and Privacy</h2>
          <p>
            Your use of the Service is also governed by our <a href="/privacy" className="text-purple-600 underline">Privacy Policy</a>,
            which describes how we collect, use, and protect your data. By using the Service, you consent
            to the practices described in the Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">10. Service Availability</h2>
          <p>
            We strive to maintain high availability but do not guarantee uninterrupted access. We may
            temporarily suspend the Service for maintenance, updates, or unforeseen circumstances.
            We will make reasonable efforts to notify users of planned downtime.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">11. Limitation of Liability</h2>
          <p>
            The Service is provided &quot;as is&quot; without warranties of any kind. TKOC shall not be liable
            for any indirect, incidental, or consequential damages arising from use of the Service.
            Our total liability shall not exceed the amount paid by you for the Service in the
            twelve months preceding the claim.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">12. Termination</h2>
          <p>
            We may suspend or terminate your access to the Service at any time for violation of these
            Terms. Upon termination, your data will be handled according to our Privacy Policy.
            You may request deletion of all your data by contacting privacy@thekingofcontent.agency.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">13. Governing Law</h2>
          <p>
            These Terms are governed by the laws of Spain. Any disputes shall be resolved in the
            courts of Barcelona, Spain.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">14. Changes to Terms</h2>
          <p>
            We may update these Terms from time to time. Continued use of the Service after changes
            constitutes acceptance. We will notify users of material changes via email.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">15. Contact</h2>
          <p>
            The King of Content S.L.<br />
            Email: legal@thekingofcontent.agency<br />
            Website: thekingofcontent.agency
          </p>
        </section>
      </div>
    </div>
  )
}

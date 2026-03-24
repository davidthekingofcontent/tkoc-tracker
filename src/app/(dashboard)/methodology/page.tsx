"use client"

import { useState } from "react"
import { useI18n } from "@/i18n/context"
import {
  BookOpen,
  Target,
  DollarSign,
  Zap,
  BarChart3,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  Users,
  Eye,
  TrendingUp,
  Shield,
  FileText,
  Clock,
  Star,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Collapsible Section ───────────────────────────────────────

function Section({
  id,
  icon: Icon,
  iconColor,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  id: string
  icon: React.ElementType
  iconColor: string
  title: string
  subtitle: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-all">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-4 px-6 py-5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <div className={cn("rounded-lg p-2.5 shrink-0", iconColor)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>
        </div>
        {open ? (
          <ChevronDown className="h-5 w-5 text-gray-400 shrink-0" />
        ) : (
          <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-6 pb-6 pt-2 border-t border-gray-100 dark:border-gray-800">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Tip Box ───────────────────────────────────────────────────

function TipBox({
  children,
  variant = "tip",
}: {
  children: React.ReactNode
  variant?: "tip" | "warning" | "success"
}) {
  const styles = {
    tip: "bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-800 dark:text-purple-200",
    warning: "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200",
    success: "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200",
  }
  const icons = {
    tip: Lightbulb,
    warning: AlertTriangle,
    success: CheckCircle2,
  }
  const IconComp = icons[variant]

  return (
    <div className={cn("rounded-lg border p-4 flex gap-3 my-4", styles[variant])}>
      <IconComp className="h-5 w-5 shrink-0 mt-0.5" />
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  )
}

// ─── Metric Card ───────────────────────────────────────────────

function MetricCard({
  icon: Icon,
  name,
  formula,
  description,
  good,
  bad,
}: {
  icon: React.ElementType
  name: string
  formula: string
  description: string
  good: string
  bad: string
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-purple-600" />
        <span className="font-semibold text-gray-900 dark:text-white text-sm">{name}</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{description}</p>
      <div className="bg-white dark:bg-gray-900 rounded px-3 py-1.5 border border-gray-200 dark:border-gray-700 mb-2">
        <code className="text-xs text-purple-600 dark:text-purple-400 font-mono">{formula}</code>
      </div>
      <div className="flex gap-4 text-xs">
        <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" /> {good}
        </span>
        <span className="text-red-500 dark:text-red-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> {bad}
        </span>
      </div>
    </div>
  )
}

// ─── Data Table ────────────────────────────────────────────────

function DataTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: string[][]
}) {
  return (
    <div className="overflow-x-auto my-4 rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800">
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Sub-heading ───────────────────────────────────────────────

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mt-6 mb-2 flex items-center gap-2">
      {children}
    </h3>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-3">{children}</p>
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 my-3 ml-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
          <span className="h-1.5 w-1.5 rounded-full bg-purple-500 mt-1.5 shrink-0" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-1.5 my-3 ml-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm text-gray-600 dark:text-gray-400">
          <span className="flex items-center justify-center h-5 w-5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-bold shrink-0 mt-0.5">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════

export default function MethodologyPage() {
  const { locale } = useI18n()
  const es = locale === "es"

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <div className="rounded-lg bg-purple-100 dark:bg-purple-900/30 p-2 text-purple-600">
            <BookOpen className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {es ? "Guia de Influencer Marketing" : "Influencer Marketing Playbook"}
          </h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 ml-12">
          {es
            ? "Todo lo que necesitas saber para planificar, ejecutar y medir campanas de influencer marketing. Practico, basado en datos reales."
            : "Everything you need to plan, execute, and measure influencer marketing campaigns. Practical, data-driven, no fluff."}
        </p>
      </div>

      {/* ─── Section 1: Campaign Planning ─────────────────────── */}
      <Section
        id="planning"
        icon={Target}
        iconColor="bg-purple-100 text-purple-600 dark:bg-purple-900/30"
        title={es ? "Como planificar una campana" : "How to Plan a Campaign"}
        subtitle={es ? "Objetivos, presupuesto, plataformas y KPIs" : "Objectives, budget, platforms, and KPIs"}
        defaultOpen
      >
        <H3>
          <Target className="h-4 w-4 text-purple-600" />
          {es ? "1. Define tu objetivo primero" : "1. Define Your Objective First"}
        </H3>
        <P>
          {es
            ? "Cada campana debe tener UN objetivo claro. El objetivo determina todo: que creadores elegir, cuanto pagar, y como medir el exito."
            : "Every campaign needs ONE clear objective. The objective determines everything: which creators to pick, how much to pay, and how to measure success."}
        </P>
        <DataTable
          headers={[
            es ? "Objetivo" : "Objective",
            es ? "Mejor para" : "Best For",
            "KPI",
            es ? "Tipo de creador" : "Creator Type",
          ]}
          rows={[
            [es ? "Conocimiento" : "Awareness", es ? "Lanzamientos, branding" : "Launches, branding", es ? "Alcance, Impresiones" : "Reach, Impressions", "Macro / Mega"],
            ["Engagement", es ? "Comunidad, UGC" : "Community, UGC", es ? "Likes, Comentarios, Saves" : "Likes, Comments, Saves", "Nano / Micro"],
            [es ? "Trafico" : "Traffic", es ? "Ventas online, apps" : "Online sales, apps", es ? "Clicks, CTR" : "Clicks, CTR", "Micro / Mid"],
            [es ? "Conversion" : "Conversion", "E-commerce, DTC", es ? "Ventas, Codigos" : "Sales, Promo Codes", "Micro / Mid"],
            [es ? "Contenido" : "Content", es ? "Activos para paid/web" : "Assets for paid/web", es ? "Calidad, Derechos" : "Quality, Rights", "Micro / Mid"],
          ]}
        />

        <H3>
          <DollarSign className="h-4 w-4 text-purple-600" />
          {es ? "2. Define el presupuesto" : "2. Set Your Budget"}
        </H3>
        <P>
          {es
            ? "El presupuesto debe basarse en tu CPM objetivo y el alcance deseado. No empieces por cuantos influencers quieres sino por cuantas personas quieres impactar."
            : "Budget should be based on your target CPM and desired reach. Don't start with how many influencers you want -- start with how many people you want to reach."}
        </P>
        <TipBox>
          {es
            ? "Formula rapida: Presupuesto = (Alcance deseado / 1,000) x CPM objetivo. Para awareness en Instagram, un CPM de 8-15 EUR es un buen punto de partida."
            : "Quick formula: Budget = (Desired Reach / 1,000) x Target CPM. For awareness on Instagram, a CPM of $8-15 is a good starting point."}
        </TipBox>

        <H3>
          <Star className="h-4 w-4 text-purple-600" />
          {es ? "3. Elige plataformas por audiencia" : "3. Choose Platforms by Audience"}
        </H3>
        <DataTable
          headers={[
            es ? "Plataforma" : "Platform",
            es ? "Mejor audiencia" : "Best Audience",
            es ? "Formato estrella" : "Star Format",
            es ? "Fuerza" : "Strength",
          ]}
          rows={[
            ["Instagram", "18-34, " + (es ? "estilo de vida" : "lifestyle"), "Reels, Stories", es ? "Visual, engagement alto" : "Visual, high engagement"],
            ["TikTok", "16-28, Gen Z", es ? "Videos cortos" : "Short-form video", es ? "Viralidad, descubrimiento" : "Virality, discovery"],
            ["YouTube", "25-44, " + (es ? "todos los nichos" : "all niches"), es ? "Videos largos, Shorts" : "Long-form, Shorts", es ? "SEO, contenido evergreen" : "SEO, evergreen content"],
          ]}
        />

        <H3>
          <Users className="h-4 w-4 text-purple-600" />
          {es ? "Estrategia de Creator Mix" : "Creator Mix Strategy"}
        </H3>
        <P>
          {es
            ? "No pongas todo el presupuesto en 1-2 creadores grandes. Diversifica entre tiers para maximizar alcance, credibilidad y volumen de contenido."
            : "Don't put all your budget on 1-2 big creators. Diversify across tiers to maximize reach, credibility, and content volume."}
        </P>
        <TipBox>
          {es
            ? "Mix recomendado para awareness (presupuesto 10K EUR): 1 Macro (3-4K EUR) para alcance masivo + 3-5 Mid (1-1.5K EUR cada uno) para credibilidad + 10-15 Micro (200-400 EUR cada uno) para comunidad y volumen de contenido."
            : "Recommended mix for awareness (budget 10K EUR): 1 Macro (3-4K EUR) for massive reach + 3-5 Mid (1-1.5K EUR each) for credibility + 10-15 Micro (200-400 EUR each) for community and content volume."}
        </TipBox>

        <H3>
          <BarChart3 className="h-4 w-4 text-purple-600" />
          {es ? "4. Define KPIs que importen" : "4. Define KPIs That Matter"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "No midas todo. Elige 2-3 KPIs alineados con tu objetivo.",
                  "Awareness: CPM, Alcance, Views.",
                  "Engagement: Engagement Rate, CPE (coste por engagement), Saves.",
                  "Trafico: CPC, CTR, Visitas.",
                  "Conversion: CPA, ROAS, Codigos canjeados.",
                  "Contenido: Coste por activo, calidad del contenido, derechos obtenidos.",
                ]
              : [
                  "Don't measure everything. Pick 2-3 KPIs aligned with your objective.",
                  "Awareness: CPM, Reach, Views.",
                  "Engagement: Engagement Rate, CPE (cost per engagement), Saves.",
                  "Traffic: CPC, CTR, Site Visits.",
                  "Conversion: CPA, ROAS, Promo Codes Redeemed.",
                  "Content: Cost per asset, content quality, rights secured.",
                ]
          }
        />
      </Section>

      {/* ─── Section 2: Choosing Influencers ──────────────────── */}
      <Section
        id="choosing"
        icon={Users}
        iconColor="bg-blue-100 text-blue-600 dark:bg-blue-900/30"
        title={es ? "Como elegir influencers" : "How to Choose Influencers"}
        subtitle={es ? "Metricas reales, red flags y benchmarks" : "Real metrics, red flags, and benchmarks"}
      >
        <H3>
          <Eye className="h-4 w-4 text-purple-600" />
          {es ? "Views > Followers" : "Views > Followers"}
        </H3>
        <P>
          {es
            ? "El numero de seguidores es una metrica de vanidad. Lo que importa son las views (visualizaciones). Un creador con 500K seguidores y 5K views por video es peor inversion que uno con 50K seguidores y 50K views."
            : "Follower count is a vanity metric. What matters is views. A creator with 500K followers and 5K views per video is a worse investment than one with 50K followers and 50K views."}
        </P>

        <H3>
          <BarChart3 className="h-4 w-4 text-purple-600" />
          {es ? "Por que la mediana importa mas que el promedio" : "Why Median Views Matter More Than Average"}
        </H3>
        <P>
          {es
            ? "Un video viral puede inflar el promedio. La mediana te dice el rendimiento tipico real. Si la mediana de views es 10K pero el promedio es 50K, probablemente tuvo un viral y el resto rinde 10K. Paga en base a la mediana."
            : "One viral video can inflate the average. The median tells you the real typical performance. If median views are 10K but average is 50K, they probably had one viral hit and the rest perform at 10K. Pay based on the median."}
        </P>
        <TipBox>
          {es
            ? "TKOC Intelligence muestra la mediana de views en el perfil de cada creador. Usa ese dato para calcular CPM real."
            : "TKOC Intelligence shows median views on every creator profile. Use that number to calculate real CPM."}
        </TipBox>

        <H3>
          <Shield className="h-4 w-4 text-purple-600" />
          {es ? "Como detectar engagement falso" : "How to Spot Fake Engagement"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Ratio likes/comentarios anormal: si tiene 10K likes y 5 comentarios, algo falla.",
                  "Comentarios genericos: emojis sueltos, 'nice!', 'great!' repetidos.",
                  "Picos repentinos de seguidores sin contenido viral que lo justifique.",
                  "Engagement rate demasiado alto (>15% en cuentas grandes es sospechoso).",
                  "Views inconsistentes: un video con 500K views y el siguiente con 2K.",
                ]
              : [
                  "Abnormal likes/comments ratio: if they have 10K likes and 5 comments, something is off.",
                  "Generic comments: random emojis, repeated 'nice!', 'great!' comments.",
                  "Sudden follower spikes without viral content to justify them.",
                  "Engagement rate too high (>15% on large accounts is suspicious).",
                  "Inconsistent views: one video with 500K views and the next with 2K.",
                ]
          }
        />

        <H3>
          <TrendingUp className="h-4 w-4 text-purple-600" />
          {es ? "Benchmarks de engagement rate por tier y plataforma" : "Engagement Rate Benchmarks by Tier & Platform"}
        </H3>
        <DataTable
          headers={[
            "Tier",
            es ? "Seguidores" : "Followers",
            "Instagram ER",
            "TikTok ER",
            "YouTube ER",
          ]}
          rows={[
            ["Nano", "<10K", "3-8%", "6-12%", "4-8%"],
            ["Micro", "10K-50K", "2-5%", "4-9%", "3-6%"],
            ["Mid", "50K-250K", "1.5-3.5%", "3-7%", "2-4%"],
            ["Macro", "250K-1M", "1-2.5%", "2-5%", "1.5-3%"],
            ["Mega", "1M+", "0.5-1.5%", "1-3%", "1-2%"],
          ]}
        />
        <TipBox variant="warning">
          {es
            ? "Un ER bajo no siempre es malo. Los mega-influencers tienen ER mas bajo pero mucho mas alcance. Evalua siempre en contexto del tier."
            : "A low ER isn't always bad. Mega-influencers have lower ER but much more reach. Always evaluate in the context of the tier."}
        </TipBox>
        <TipBox>
          {es
            ? "Importante: este ER se calcula sobre seguidores (formula de perfil). En campana, el engagement rate se calcula sobre views o reach, lo que da numeros diferentes. TKOC Intelligence usa automaticamente la formula correcta segun el contexto."
            : "Important: this ER is calculated on followers (profile formula). In campaigns, engagement rate is calculated on views or reach, which gives different numbers. TKOC Intelligence automatically uses the correct formula based on context."}
        </TipBox>

        <H3>
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {es ? "Red flags a vigilar" : "Red Flags to Watch For"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Nunca ha hecho contenido en tu nicho/categoria.",
                  "Pide el pago completo por adelantado sin contrato.",
                  "No comparte estadisticas o usa capturas editadas.",
                  "Historial de controversias o contenido problematico.",
                  "Audiencia en paises que no te interesan (comprueba demograficos).",
                  "Crecimiento inorganico: muchos seguidores, poco engagement real.",
                ]
              : [
                  "Never created content in your niche/category.",
                  "Requests full payment upfront without a contract.",
                  "Won't share stats or uses edited screenshots.",
                  "History of controversies or problematic content.",
                  "Audience in countries that aren't your target (check demographics).",
                  "Inorganic growth: many followers, little real engagement.",
                ]
          }
        />

        <H3>
          <Users className="h-4 w-4 text-purple-600" />
          {es ? "Calidad de audiencia" : "Audience Quality"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Comprueba la geografia de la audiencia: el 80% deberia estar en tu mercado objetivo.",
                  "Verifica que la edad y genero de la audiencia coincidan con el target de tu marca.",
                  "Vigila el solapamiento de audiencia entre influencers: evita pagar dos veces por los mismos ojos.",
                  "Deteccion de seguidores falsos: picos repentinos de seguidores sin contenido viral que lo justifique.",
                ]
              : [
                  "Check audience geography: 80% of the audience should be in your target market.",
                  "Verify audience age and gender alignment with your brand's target.",
                  "Watch for audience overlap between influencers: avoid paying twice for the same eyeballs.",
                  "Fake followers detection: sudden follower spikes without viral content to justify them.",
                ]
          }
        />

        <H3>
          <Star className="h-4 w-4 text-purple-600" />
          {es ? "Calidad del contenido" : "Content Quality"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Revisa los ultimos 10-15 posts: estan bien producidos? Son naturales?",
                  "La estetica del creador encaja con tu marca?",
                  "Los captions son atractivos? Cuentan historias o solo promocionan?",
                  "El creador ha hecho colaboraciones con marcas antes? Como se veian?",
                  "Podrias reutilizar este contenido para paid ads? (alto valor de produccion = bonus).",
                ]
              : [
                  "Review the last 10-15 posts: are they well-produced? Natural?",
                  "Does the creator's aesthetic match your brand?",
                  "Are captions engaging? Do they tell stories or just promote?",
                  "Has the creator done brand collabs before? How did they look?",
                  "Could you reuse this content for paid ads? (high production value = bonus).",
                ]
          }
        />
      </Section>

      {/* ─── Section 3: How Much to Pay ───────────────────────── */}
      <Section
        id="pricing"
        icon={DollarSign}
        iconColor="bg-green-100 text-green-600 dark:bg-green-900/30"
        title={es ? "Cuanto pagar" : "How Much to Pay"}
        subtitle={es ? "CPM, rangos de mercado y negociacion" : "CPM, market ranges, and negotiation"}
      >
        <H3>
          <DollarSign className="h-4 w-4 text-purple-600" />
          {es ? "Como funciona el CPM y por que importa" : "How CPM Works and Why It Matters"}
        </H3>
        <P>
          {es
            ? "CPM (Coste por Mil impresiones) es la metrica universal para comparar precios. Divide lo que pagas entre las views esperadas (mediana) y multiplica por 1,000. Esto normaliza creadores de todos los tamanos."
            : "CPM (Cost per Mille / thousand impressions) is the universal metric to compare pricing. Divide what you pay by the expected views (median) and multiply by 1,000. This normalizes creators of all sizes."}
        </P>
        <TipBox>
          {es
            ? "Formula: CPM = (Fee / Median Views) x 1,000. Si pagas 500 EUR y la mediana de views es 50K, tu CPM es 10 EUR. Compara esto con otros creadores para encontrar el mejor valor."
            : "Formula: CPM = (Fee / Median Views) x 1,000. If you pay $500 and median views are 50K, your CPM is $10. Compare across creators to find the best value."}
        </TipBox>

        <H3>
          <BarChart3 className="h-4 w-4 text-purple-600" />
          {es ? "Rangos de mercado por plataforma y tier" : "Market Ranges by Platform & Tier"}
        </H3>
        <P>
          {es
            ? "Estos son rangos orientativos para el mercado europeo/LATAM. USA suele ser 1.5-2x mas caro."
            : "These are indicative ranges for the European/LATAM market. US rates are typically 1.5-2x higher."}
        </P>
        <DataTable
          headers={[
            "Tier",
            es ? "Seguidores" : "Followers",
            es ? "Instagram (por post)" : "Instagram (per post)",
            es ? "TikTok (por video)" : "TikTok (per video)",
            es ? "YouTube (por video)" : "YouTube (per video)",
          ]}
          rows={[
            ["Nano", "<10K", "30-150 EUR", "30-100 EUR", "50-200 EUR"],
            ["Micro", "10K-50K", "100-400 EUR", "100-350 EUR", "200-600 EUR"],
            ["Mid", "50K-250K", "400-1,500 EUR", "400-1,200 EUR", "600-2,000 EUR"],
            ["Macro", "250K-1M", "1,500-5,000 EUR", "1,200-4,000 EUR", "2,000-8,000 EUR"],
            ["Mega", "1M+", "5,000-25,000 EUR", "4,000-20,000 EUR", "8,000-50,000 EUR"],
          ]}
        />

        <H3>
          <FileText className="h-4 w-4 text-purple-600" />
          {es ? "Valor por formato" : "Value by Format"}
        </H3>
        <DataTable
          headers={[
            es ? "Formato" : "Format",
            es ? "Duracion" : "Duration",
            es ? "Valor" : "Value",
            es ? "Notas" : "Notes",
          ]}
          rows={
            es
              ? [
                  ["Reel / TikTok video", "15-90s", "Alto", "Mejor alcance y potencial de viralidad"],
                  ["Story (IG)", "24h", "Bajo-Medio", "Efimero, bueno para trafico con swipe-up"],
                  ["Post estatico", "Permanente", "Medio", "Bueno para imagen de marca, bajo alcance"],
                  ["YouTube video", "5-15min", "Muy alto", "Valor SEO, evergreen, engagement profundo"],
                  ["YouTube Short", "15-60s", "Medio", "Alcance creciente, menor coste de produccion"],
                  ["Carousel", "Permanente", "Medio-Alto", "Alta tasa de guardados, bueno para educacion"],
                ]
              : [
                  ["Reel / TikTok video", "15-90s", "High", "Best reach and virality potential"],
                  ["Story (IG)", "24h", "Low-Medium", "Ephemeral, good for traffic with swipe-up"],
                  ["Static post", "Permanent", "Medium", "Good for brand image, low reach"],
                  ["YouTube video", "5-15min", "Very high", "SEO value, evergreen, deep engagement"],
                  ["YouTube Short", "15-60s", "Medium", "Growing reach, lower production cost"],
                  ["Carousel", "Permanent", "Medium-High", "High saves rate, good for education"],
                ]
          }
        />

        <H3>
          <Star className="h-4 w-4 text-purple-600" />
          {es ? "Cuando el gifting esta bien vs cuando hay que pagar" : "When Gifting Is OK vs When to Pay"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Gifting funciona con: nano-influencers, productos de alto valor percibido, creadores que ya usan tu marca.",
                  "Paga siempre cuando: pides contenido especifico, necesitas derechos de uso, el creador tiene mas de 50K seguidores, o necesitas publicacion garantizada.",
                  "Gifting + fee pequeno es un buen punto intermedio para micro-influencers.",
                ]
              : [
                  "Gifting works with: nano-influencers, high perceived value products, creators who already use your brand.",
                  "Always pay when: you request specific content, need usage rights, the creator has 50K+ followers, or you need guaranteed posting.",
                  "Gifting + small fee is a good middle ground for micro-influencers.",
                ]
          }
        />

        <H3>
          <FileText className="h-4 w-4 text-purple-600" />
          {es ? "Consejos de negociacion" : "Negotiation Tips"}
        </H3>
        <NumberedList
          items={
            es
              ? [
                  "Pide las tarifas antes de dar tu presupuesto. Deja que ellos propongan primero.",
                  "Ofrece paquetes: mas contenido = mejor precio por pieza.",
                  "Ofrece relaciones a largo plazo: 3-6 meses de collab a cambio de mejor tarifa.",
                  "Negocia derechos de uso por separado. Los derechos de paid media suelen costar 30-50% extra.",
                  "Si el CPM resultante es demasiado alto, busca otro creador. No pagues de mas por 'nombre'.",
                ]
              : [
                  "Ask for their rates before stating your budget. Let them propose first.",
                  "Offer packages: more content = better price per piece.",
                  "Offer long-term relationships: 3-6 month collabs in exchange for better rates.",
                  "Negotiate usage rights separately. Paid media rights typically cost 30-50% extra.",
                  "If the resulting CPM is too high, find another creator. Don't overpay for 'name value'.",
                ]
          }
        />

        <H3>
          <Shield className="h-4 w-4 text-purple-600" />
          {es ? "Exclusividad" : "Exclusivity"}
        </H3>
        <P>
          {es
            ? "La exclusividad significa que el creador no puede trabajar con competidores directos durante un periodo determinado. Es una herramienta poderosa pero tiene un coste."
            : "Exclusivity means the creator cannot work with direct competitors for a set period. It's a powerful tool but it comes at a cost."}
        </P>
        <BulletList
          items={
            es
              ? [
                  "Exclusividad de categoria: el creador no puede trabajar con competidores durante X semanas/meses.",
                  "Coste tipico: 20-50% de prima sobre el fee base.",
                  "La duracion importa: 2 semanas es razonable, 6 meses es caro.",
                  "Solo pide exclusividad con creadores Macro/Mega o en mercados muy competitivos.",
                  "Siempre pon los terminos de exclusividad por escrito con nombres especificos de competidores.",
                ]
              : [
                  "Category exclusivity: creator can't work with competitors for X weeks/months.",
                  "Typical cost: 20-50% premium on top of base fee.",
                  "Duration matters: 2 weeks is reasonable, 6 months is expensive.",
                  "Only ask for exclusivity with Macro/Mega creators or in very competitive markets.",
                  "Always put exclusivity terms in writing with specific competitor names.",
                ]
          }
        />

        <H3>
          <Shield className="h-4 w-4 text-purple-600" />
          {es ? "Que significa 'incluye derechos' en el precio" : "What 'Includes Rights' Means for Pricing"}
        </H3>
        <P>
          {es
            ? "Cuando un creador dice que su fee 'incluye derechos', pregunta siempre: derechos para que (organic, paid, web)? por cuanto tiempo? en que territorios? Los derechos de uso para paid media (boosting, whitelisting) suelen ser un 30-50% adicional sobre el fee base. Derechos a perpetuidad suelen costar mas. Siempre pon los derechos por escrito en el contrato."
            : "When a creator says their fee 'includes rights', always ask: rights for what (organic, paid, web)? For how long? In which territories? Usage rights for paid media (boosting, whitelisting) are typically 30-50% additional on top of the base fee. Perpetuity rights usually cost more. Always put rights in writing in the contract."}
        </P>
      </Section>

      {/* ─── Section 4: Execution ─────────────────────────────── */}
      <Section
        id="execution"
        icon={Zap}
        iconColor="bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30"
        title={es ? "Como ejecutar" : "How to Execute"}
        subtitle={es ? "Briefs, aprobaciones, tiempos y compliance" : "Briefs, approvals, timelines, and compliance"}
      >
        <H3>
          <FileText className="h-4 w-4 text-purple-600" />
          {es ? "Best practices para el brief" : "Brief Best Practices"}
        </H3>
        <P>
          {es
            ? "Un buen brief es la diferencia entre contenido increible y contenido generico. Se claro en lo que quieres pero da libertad creativa."
            : "A good brief is the difference between amazing content and generic content. Be clear about what you want but give creative freedom."}
        </P>
        <BulletList
          items={
            es
              ? [
                  "Incluye: objetivo, mensajes clave (max 2-3), do's and don'ts, timeline, hashtags obligatorios.",
                  "Comparte ejemplos de contenido que te gusta (y que NO te gusta).",
                  "No escribas un guion. Da puntos clave y deja que el creador lo haga suyo.",
                  "Especifica formato: Reel, Story, Post estatico, video largo, etc.",
                  "Incluye requisitos legales: #ad, mencion de marca, disclaimers.",
                  "Envia el brief en un doc claro, no en 15 mensajes de WhatsApp.",
                ]
              : [
                  "Include: objective, key messages (max 2-3), do's and don'ts, timeline, mandatory hashtags.",
                  "Share examples of content you like (and what you DON'T like).",
                  "Don't write a script. Give key points and let the creator make it their own.",
                  "Specify format: Reel, Story, Static post, long-form video, etc.",
                  "Include legal requirements: #ad, brand mention, disclaimers.",
                  "Send the brief in a clean doc, not in 15 WhatsApp messages.",
                ]
          }
        />

        <H3>
          <CheckCircle2 className="h-4 w-4 text-purple-600" />
          {es ? "Flujo de aprobacion de contenido" : "Content Approval Flow"}
        </H3>
        <NumberedList
          items={
            es
              ? [
                  "Creador envia borrador (idealmente video sin editar + caption).",
                  "Revision interna (max 2 rondas de feedback).",
                  "Aprobacion con fecha de publicacion acordada.",
                  "Creador publica. Confirma con link/screenshot.",
                  "Tu equipo trackea metricas en TKOC Intelligence.",
                ]
              : [
                  "Creator sends draft (ideally raw video + caption).",
                  "Internal review (max 2 rounds of feedback).",
                  "Approval with agreed publication date.",
                  "Creator publishes. Confirms with link/screenshot.",
                  "Your team tracks metrics in TKOC Intelligence.",
                ]
          }
        />
        <TipBox variant="warning">
          {es
            ? "No pidas mas de 2 rondas de revision. Mata la creatividad y deteriora la relacion. Si necesitas mas de 2 rondas, el brief era malo."
            : "Don't ask for more than 2 rounds of revisions. It kills creativity and damages the relationship. If you need more than 2 rounds, the brief was bad."}
        </TipBox>

        <H3>
          <Clock className="h-4 w-4 text-purple-600" />
          {es ? "Timeline y envio de producto" : "Shipping Timeline"}
        </H3>
        <P>
          {es
            ? "Planifica al menos 4-6 semanas desde primer contacto hasta publicacion. Si hay envio de producto, anade 1-2 semanas mas."
            : "Plan at least 4-6 weeks from first contact to publication. If product shipping is involved, add 1-2 more weeks."}
        </P>
        <DataTable
          headers={[es ? "Fase" : "Phase", es ? "Duracion" : "Duration"]}
          rows={
            es
              ? [
                  ["Contacto + negociacion", "1-2 semanas"],
                  ["Envio de producto (si aplica)", "1-2 semanas"],
                  ["Creacion de contenido", "1-2 semanas"],
                  ["Revision + aprobacion", "3-5 dias"],
                  ["Publicacion", "Fecha acordada"],
                ]
              : [
                  ["Outreach + negotiation", "1-2 weeks"],
                  ["Product shipping (if applicable)", "1-2 weeks"],
                  ["Content creation", "1-2 weeks"],
                  ["Review + approval", "3-5 days"],
                  ["Publication", "Agreed date"],
                ]
          }
        />

        <H3>
          <Shield className="h-4 w-4 text-purple-600" />
          {es ? "Requisitos de disclosure (#ad, #sponsored)" : "Disclosure Requirements (#ad, #sponsored)"}
        </H3>
        <P>
          {es
            ? "En la UE, USA, y la mayoria de mercados, la publicidad debe ser identificada claramente. No hacerlo puede resultar en multas para la marca Y el creador."
            : "In the EU, US, and most markets, advertising must be clearly identified. Failure to do so can result in fines for BOTH the brand AND the creator."}
        </P>
        <BulletList
          items={
            es
              ? [
                  "Instagram: Usa la herramienta de 'Colaboracion pagada' + #ad en el caption.",
                  "TikTok: Activa 'Contenido de marca' + #ad visible.",
                  "YouTube: Activa 'Incluye promocion pagada' + mencion verbal.",
                  "#ad o #publicidad deben estar visibles, no escondidos entre 20 hashtags.",
                  "Gifting tambien debe declararse si hay expectativa de publicacion.",
                ]
              : [
                  "Instagram: Use the 'Paid partnership' tool + #ad in the caption.",
                  "TikTok: Enable 'Branded content' toggle + visible #ad.",
                  "YouTube: Enable 'Includes paid promotion' + verbal mention.",
                  "#ad or #sponsored must be visible, not hidden among 20 hashtags.",
                  "Gifting must also be disclosed if there's an expectation of posting.",
                ]
          }
        />

        <H3>
          <TrendingUp className="h-4 w-4 text-purple-600" />
          {es ? "Whitelisting, Spark Ads y Partnership Ads" : "Whitelisting, Spark Ads & Partnership Ads"}
        </H3>
        <P>
          {es
            ? "Esta es la tendencia #1 de 2024-2026. Las marcas pueden amplificar el contenido del creador via paid media usando el handle del creador, combinando la autenticidad del influencer con la precision del paid."
            : "This is the #1 trend of 2024-2026. Brands can boost creator content via paid media using the creator's handle, combining influencer authenticity with paid media precision."}
        </P>
        <BulletList
          items={
            es
              ? [
                  "Instagram Partnership Ads: el creador te da permisos de publicidad via la herramienta de Branded Content.",
                  "TikTok Spark Ads: el creador comparte un codigo de autorizacion que te permite amplificar su video.",
                  "YouTube BrandConnect: promocion integrada de contenido de marca.",
                  "Coste de whitelisting: tipicamente 20-40% adicional sobre el fee organico.",
                  "Negocia siempre los derechos de whitelisting antes de que el contenido este en vivo, no despues.",
                ]
              : [
                  "Instagram Partnership Ads: the creator gives you ad permissions via the Branded Content tool.",
                  "TikTok Spark Ads: the creator shares an authorization code that lets you boost their video.",
                  "YouTube BrandConnect: integrated brand content promotion.",
                  "Whitelisting costs: typically 20-40% on top of the organic fee.",
                  "Always negotiate whitelisting rights upfront, not after the content is live.",
                ]
          }
        />
        <TipBox>
          {es
            ? "TKOC Intelligence permite a los creadores conectar sus cuentas para facilitar permisos de whitelisting y Spark Ads directamente desde la plataforma."
            : "TKOC Intelligence allows creators to connect their accounts to facilitate whitelisting and Spark Ads permissions directly from the platform."}
        </TipBox>

        <H3>
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {es ? "Errores comunes" : "Common Mistakes"}
        </H3>
        <BulletList
          items={
            es
              ? [
                  "Micro-gestionar el contenido: el creador conoce a su audiencia mejor que tu.",
                  "No tener contrato escrito: siempre, aunque sea gifting.",
                  "Estructura de pago recomendada: Nano/Micro: 100% al aprobar contenido. Mid: 50% al firmar, 50% al publicar. Macro/Mega: 30% al firmar, 40% al aprobar, 30% al publicar. Adapta segun la relacion y el tier.",
                  "No dar suficiente tiempo: el contenido apresurado se nota.",
                  "Ignorar el disclosure: es un riesgo legal real.",
                  "No trackear nada: si no mides, no aprendes.",
                ]
              : [
                  "Micro-managing content: the creator knows their audience better than you.",
                  "No written contract: always have one, even for gifting.",
                  "Recommended payment structure: Nano/Micro: 100% on content approval. Mid: 50% on signing, 50% on publication. Macro/Mega: 30% on signing, 40% on approval, 30% on publication. Adapt based on relationship and tier.",
                  "Not allowing enough time: rushed content shows.",
                  "Ignoring disclosure: it's a real legal risk.",
                  "Not tracking anything: if you don't measure, you don't learn.",
                ]
          }
        />
      </Section>

      {/* ─── Section 5: Measuring Results ─────────────────────── */}
      <Section
        id="measuring"
        icon={BarChart3}
        iconColor="bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30"
        title={es ? "Como medir resultados" : "How to Measure Results"}
        subtitle={es ? "EMV, ROI real y que reportar" : "EMV, real ROI, and what to report"}
      >
        <H3>
          <Zap className="h-4 w-4 text-purple-600" />
          {es ? "Que significa EMV (y que no)" : "What EMV Means (and What It Doesn't)"}
        </H3>
        <P>
          {es
            ? "EMV (Earned Media Value) estima cuanto habria costado obtener el mismo alcance/engagement a traves de publicidad pagada. Es una metrica de referencia, no de ROI real."
            : "EMV (Earned Media Value) estimates how much it would have cost to achieve the same reach/engagement through paid advertising. It's a reference metric, not a real ROI metric."}
        </P>
        <BulletList
          items={
            es
              ? [
                  "EMV es util para: comparar campanas entre si, justificar inversion vs paid media, benchmarking.",
                  "EMV NO es: dinero real ganado, una garantia de ventas, ni un calculo exacto.",
                  "TKOC Intelligence calcula EMV usando CPMs de referencia de paid media: Instagram EUR 8, TikTok EUR 6, YouTube EUR 12. Estos son CPMs de publicidad pagada, no de influencer marketing. Se usan como comparativa: si el EMV supera tu inversion, significa que el alcance organico del influencer te ha salido mas barato que comprarlo via ads.",
                  "Un EMV Ratio (EMV/Inversion) de 2x o superior se considera buen resultado.",
                ]
              : [
                  "EMV is useful for: comparing campaigns, justifying investment vs paid media, benchmarking.",
                  "EMV is NOT: real money earned, a guarantee of sales, or an exact calculation.",
                  "TKOC Intelligence calculates EMV using paid media reference CPMs: Instagram $8, TikTok $6, YouTube $12. These are paid advertising CPMs, not influencer marketing CPMs. They are used as a benchmark: if the EMV exceeds your investment, it means the influencer's organic reach cost you less than buying it through ads.",
                  "An EMV Ratio (EMV/Investment) of 2x or higher is considered a good result.",
                ]
          }
        />

        <H3>
          <TrendingUp className="h-4 w-4 text-purple-600" />
          {es ? "Como calcular ROI real" : "How to Calculate Real ROI"}
        </H3>
        <P>
          {es
            ? "El ROI real depende de tu objetivo. Para conversion: (Revenue - Inversion) / Inversion x 100. Para awareness: compara CPM logrado vs CPM de paid media. Para engagement: compara CPE logrado vs benchmarks."
            : "Real ROI depends on your objective. For conversion: (Revenue - Investment) / Investment x 100. For awareness: compare achieved CPM vs paid media CPM. For engagement: compare achieved CPE vs benchmarks."}
        </P>
        <TipBox variant="success">
          {es
            ? "Tip pro: usa codigos de descuento unicos por creador y UTMs en los links para atribuir ventas directamente a cada influencer."
            : "Pro tip: use unique discount codes per creator and UTMs in links to attribute sales directly to each influencer."}
        </TipBox>

        <H3>
          <FileText className="h-4 w-4 text-purple-600" />
          {es ? "Que reportar al cliente" : "What to Report to Clients"}
        </H3>
        <NumberedList
          items={
            es
              ? [
                  "Resumen ejecutivo: objetivo, inversion, resultado principal.",
                  "KPIs vs objetivos: que se logro vs que se busco.",
                  "Top performers: que creadores funcionaron mejor y por que.",
                  "Metricas clave: views, engagement, CPM, EMV, EMV Ratio.",
                  "Aprendizajes: que funciono, que no, y recomendaciones para la siguiente.",
                  "Contenido destacado: los mejores posts/videos de la campana.",
                ]
              : [
                  "Executive summary: objective, investment, main result.",
                  "KPIs vs goals: what was achieved vs what was targeted.",
                  "Top performers: which creators performed best and why.",
                  "Key metrics: views, engagement, CPM, EMV, EMV Ratio.",
                  "Learnings: what worked, what didn't, and recommendations for next time.",
                  "Highlighted content: best posts/videos from the campaign.",
                ]
          }
        />

        <H3>
          <Users className="h-4 w-4 text-purple-600" />
          {es ? "Cuando repetir vs no repetir con un creador" : "When to Repeat vs Skip a Creator"}
        </H3>
        <DataTable
          headers={[
            es ? "Repetir" : "Repeat",
            es ? "No repetir" : "Don't Repeat",
          ]}
          rows={
            es
              ? [
                  ["CPM por debajo del benchmark del tier", "CPM muy por encima del mercado"],
                  ["Engagement rate consistente", "Engagement cayo significativamente"],
                  ["Contenido de alta calidad", "Contenido generico o bajo esfuerzo"],
                  ["Buena comunicacion y profesionalismo", "Dificil de gestionar, entregas tardes"],
                  ["Audiencia alineada con tu target", "Audiencia no relevante"],
                  ["Convierte (si es objetivo de conversion)", "Cero conversiones en multiples collabs"],
                ]
              : [
                  ["CPM below tier benchmark", "CPM far above market rates"],
                  ["Consistent engagement rate", "Engagement dropped significantly"],
                  ["High-quality content", "Generic or low-effort content"],
                  ["Good communication and professionalism", "Difficult to manage, late deliveries"],
                  ["Audience aligned with your target", "Irrelevant audience"],
                  ["Converts (if conversion is the goal)", "Zero conversions across multiple collabs"],
                ]
          }
        />
      </Section>

      {/* ─── Section 6: Key Metrics Explained ─────────────────── */}
      <Section
        id="metrics"
        icon={HelpCircle}
        iconColor="bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30"
        title={es ? "Metricas clave explicadas" : "Key Metrics Explained"}
        subtitle={es ? "Definiciones, formulas y referencias" : "Definitions, formulas, and benchmarks"}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <MetricCard
            icon={DollarSign}
            name="CPM"
            formula={es ? "CPM = (Coste / Impresiones) x 1,000" : "CPM = (Cost / Impressions) x 1,000"}
            description={
              es
                ? "Coste por mil impresiones. La metrica estandar para comparar eficiencia de costes entre creadores y plataformas."
                : "Cost per thousand impressions. The standard metric to compare cost efficiency across creators and platforms."
            }
            good={es ? "< 10 EUR (IG), < 8 EUR (TT)" : "< $10 (IG), < $8 (TT)"}
            bad={es ? "> 25 EUR" : "> $25"}
          />
          <MetricCard
            icon={Target}
            name="CPE"
            formula={es ? "CPE = Coste / Engagements totales" : "CPE = Cost / Total Engagements"}
            description={
              es
                ? "Coste por engagement (like, comentario, save, share). Ideal para campanas de engagement y comunidad."
                : "Cost per engagement (like, comment, save, share). Ideal for engagement and community campaigns."
            }
            good={es ? "< 0.10 EUR" : "< $0.10"}
            bad={es ? "> 0.50 EUR" : "> $0.50"}
          />
          <MetricCard
            icon={Eye}
            name="CPV"
            formula={es ? "CPV = Coste / Views totales" : "CPV = Cost / Total Views"}
            description={
              es
                ? "Coste por visualizacion. Especialmente relevante en TikTok y YouTube donde las views son la metrica principal."
                : "Cost per view. Especially relevant on TikTok and YouTube where views are the primary metric."
            }
            good={es ? "< 0.03 EUR" : "< $0.03"}
            bad={es ? "> 0.10 EUR" : "> $0.10"}
          />
          <MetricCard
            icon={Zap}
            name="EMV"
            formula={es ? "EMV = Views x CPM de mercado / 1,000" : "EMV = Views x Market CPM / 1,000"}
            description={
              es
                ? "Earned Media Value. Valor estimado del alcance obtenido si se hubiera pagado como publicidad. Metrica de referencia, no de ROI."
                : "Earned Media Value. Estimated value of reach obtained if it had been paid for as advertising. Reference metric, not ROI."
            }
            good={es ? "EMV Ratio > 2x" : "EMV Ratio > 2x"}
            bad={es ? "EMV Ratio < 1x" : "EMV Ratio < 1x"}
          />
          <MetricCard
            icon={TrendingUp}
            name={es ? "Engagement Rate (ER)" : "Engagement Rate (ER)"}
            formula="ER = (Likes + Comments) / Followers x 100"
            description={
              es
                ? "Porcentaje de seguidores que interactuan con el contenido. Vara por tier y plataforma (ver tabla de benchmarks arriba)."
                : "Percentage of followers that interact with content. Varies by tier and platform (see benchmark table above)."
            }
            good={es ? "Por encima del benchmark del tier" : "Above tier benchmark"}
            bad={es ? "50% o menos del benchmark" : "50% or less of benchmark"}
          />
          <MetricCard
            icon={BarChart3}
            name={es ? "EMV Ratio" : "EMV Ratio"}
            formula={es ? "EMV Ratio = EMV / Inversion total" : "EMV Ratio = EMV / Total Investment"}
            description={
              es
                ? "Cuantos euros de valor mediatico obtienes por cada euro invertido. El KPI principal para evaluar eficiencia de una campana."
                : "How many dollars of media value you get for every dollar invested. The primary KPI to evaluate campaign efficiency."
            }
            good="> 2x"
            bad="< 1x"
          />
        </div>

        <TipBox>
          {es
            ? "Todas estas metricas se calculan automaticamente en TKOC Intelligence cuando anaes media e inversion a tus campanas. No hace falta calcular nada a mano."
            : "All these metrics are calculated automatically in TKOC Intelligence when you add media and investment to your campaigns. No manual calculations needed."}
        </TipBox>
      </Section>

      {/* Footer */}
      <div className="text-center py-6">
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {es
            ? "Esta guia se actualiza regularmente con datos y benchmarks del mercado. Ultima actualizacion: Marzo 2026."
            : "This playbook is regularly updated with market data and benchmarks. Last updated: March 2026."}
        </p>
      </div>
    </div>
  )
}

import { SPAIN_CATEGORIES } from '@/lib/spain-categories'

// ============ TYPES ============

export interface SpainFitInput {
  bio?: string | null
  captions?: string[]
  hashtags?: string[]
  mentions?: string[]
  postTimestamps?: Date[]
  city?: string | null
  country?: string | null
  language?: string | null
  comments?: string[]
}

export interface SpainFitResult {
  score: number
  level: 'confirmed' | 'probable' | 'partial' | 'hispanic_global' | 'latam' | 'unknown'
  signal: 'green' | 'yellow' | 'red' | 'gray'
  explanation: string
  components: {
    languageScore: { score: number; detail: string; isInferred: boolean }
    locationScore: { score: number; detail: string; isInferred: boolean }
    timezoneScore: { score: number; detail: string; isInferred: boolean }
    hashtagsScore: { score: number; detail: string; isInferred: boolean }
    brandsScore: { score: number; detail: string; isInferred: boolean }
    audienceScore: { score: number; detail: string; isInferred: boolean }
  }
  detectedCity?: string
  detectedProvince?: string
  confidence: number
}

// ============ CONSTANTS ============

const SPANISH_CITIES: Record<string, string> = {
  // City -> Province
  'madrid': 'Madrid',
  'barcelona': 'Barcelona',
  'valencia': 'Valencia',
  'sevilla': 'Sevilla',
  'bilbao': 'Bizkaia',
  'málaga': 'Málaga',
  'malaga': 'Málaga',
  'zaragoza': 'Zaragoza',
  'murcia': 'Murcia',
  'palma': 'Illes Balears',
  'palma de mallorca': 'Illes Balears',
  'las palmas': 'Las Palmas',
  'alicante': 'Alicante',
  'córdoba': 'Córdoba',
  'cordoba': 'Córdoba',
  'valladolid': 'Valladolid',
  'vigo': 'Pontevedra',
  'gijón': 'Asturias',
  'gijon': 'Asturias',
  'granada': 'Granada',
  'san sebastián': 'Gipuzkoa',
  'san sebastian': 'Gipuzkoa',
  'donostia': 'Gipuzkoa',
  'santander': 'Cantabria',
  'pamplona': 'Navarra',
  'toledo': 'Toledo',
  'salamanca': 'Salamanca',
  'cádiz': 'Cádiz',
  'cadiz': 'Cádiz',
  'huelva': 'Huelva',
  'almería': 'Almería',
  'almeria': 'Almería',
  'jaén': 'Jaén',
  'jaen': 'Jaén',
  'lleida': 'Lleida',
  'girona': 'Girona',
  'tarragona': 'Tarragona',
  'castellón': 'Castellón',
  'castellon': 'Castellón',
  'badajoz': 'Badajoz',
  'cáceres': 'Cáceres',
  'caceres': 'Cáceres',
  'león': 'León',
  'leon': 'León',
  'burgos': 'Burgos',
  'albacete': 'Albacete',
  'ciudad real': 'Ciudad Real',
  'guadalajara': 'Guadalajara',
  'cuenca': 'Cuenca',
  'segovia': 'Segovia',
  'ávila': 'Ávila',
  'avila': 'Ávila',
  'soria': 'Soria',
  'zamora': 'Zamora',
  'palencia': 'Palencia',
  'huesca': 'Huesca',
  'teruel': 'Teruel',
  'logroño': 'La Rioja',
  'logrono': 'La Rioja',
  'vitoria': 'Álava',
  'mérida': 'Badajoz',
  'merida': 'Badajoz',
  'a coruña': 'A Coruña',
  'coruña': 'A Coruña',
  'lugo': 'Lugo',
  'ourense': 'Ourense',
  'pontevedra': 'Pontevedra',
  'oviedo': 'Asturias',
  'tenerife': 'Santa Cruz de Tenerife',
  'santa cruz de tenerife': 'Santa Cruz de Tenerife',
  'lanzarote': 'Las Palmas',
  'fuerteventura': 'Las Palmas',
  'ibiza': 'Illes Balears',
  'menorca': 'Illes Balears',
  'elche': 'Alicante',
  'hospitalet': 'Barcelona',
  'getafe': 'Madrid',
  'alcalá de henares': 'Madrid',
  'móstoles': 'Madrid',
  'marbella': 'Málaga',
  'torremolinos': 'Málaga',
  'benidorm': 'Alicante',
}

const SPAIN_PROVINCES = [
  'álava', 'alava', 'albacete', 'alicante', 'almería', 'almeria', 'asturias',
  'ávila', 'avila', 'badajoz', 'barcelona', 'bizkaia', 'vizcaya', 'burgos',
  'cáceres', 'caceres', 'cádiz', 'cadiz', 'cantabria', 'castellón', 'castellon',
  'ciudad real', 'córdoba', 'cordoba', 'a coruña', 'cuenca', 'gipuzkoa', 'guipúzcoa',
  'girona', 'granada', 'guadalajara', 'huelva', 'huesca', 'illes balears', 'baleares',
  'jaén', 'jaen', 'la rioja', 'las palmas', 'león', 'leon', 'lleida', 'lugo',
  'madrid', 'málaga', 'malaga', 'murcia', 'navarra', 'ourense', 'palencia',
  'pontevedra', 'salamanca', 'santa cruz de tenerife', 'segovia', 'sevilla',
  'soria', 'tarragona', 'teruel', 'toledo', 'valencia', 'valladolid', 'zamora', 'zaragoza',
]

/** Peninsular Spanish markers (Spain-specific vocabulary) */
const PENINSULAR_MARKERS = [
  'vosotros', 'tío', 'tio', 'mola', 'flipar', 'currar', 'chaval', 'guay',
  'quedada', 'majo', 'maja', 'flipante', 'mogollón', 'mogollon', 'cojonudo',
  'gilipollas', 'hostia', 'joder', 'vale', 'venga', 'anda ya', 'mazo',
  'quedamos', 'piso', 'mola mucho', 'tía', 'tia', 'boli', 'cole', 'finde',
  'curro', 'iros', 'pillar', 'liarse', 'chungo', 'pasada', 'coche',
]

/** LATAM Spanish markers (to distinguish from peninsular) */
const LATAM_MARKERS = [
  'ustedes', 'chévere', 'chevere', 'plata', 'güey', 'guey', 'vos', 'pana',
  'chido', 'bacán', 'bacan', 'pues', 'parce', 'parcero', 'neta', 'chamo',
  'cuate', 'carnal', 'jale', 'chamba', 'feria', 'lana', 'padre', 'chingón',
  'chingon', 'vaina', 'arrecho', 'nota', 'marico', 'tuanis', 'pura vida',
  'carro', 'celular', 'computadora', 'durazno', 'frijol',
]

/** Spanish-specific hashtags */
const SPAIN_HASHTAGS = [
  '#españa', '#espana', '#spain', '#madrid', '#barcelona', '#valencia',
  '#sevilla', '#bilbao', '#málaga', '#malaga', '#español', '#espanol',
  '#viralespañol', '#viralespanol', '#españa🇪🇸', '#madeInspain',
  '#hechoenespaña', '#marcaespaña', '#productosespañoles',
]

// ============ HELPERS ============

function normalizeText(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function containsAny(text: string, words: string[]): string[] {
  const lower = text.toLowerCase()
  return words.filter(w => {
    const wLower = w.toLowerCase()
    // Word boundary check: make sure it's not part of a longer word
    const idx = lower.indexOf(wLower)
    if (idx === -1) return false
    const before = idx > 0 ? lower[idx - 1] : ' '
    const after = idx + wLower.length < lower.length ? lower[idx + wLower.length] : ' '
    const isBoundary = (c: string) => /[\s.,;:!?#@\-_/()'"¿¡]/.test(c) || c === ' '
    return isBoundary(before) && isBoundary(after)
  })
}

function detectSpanishLanguage(texts: string[]): { isSpanish: boolean; isPeninsular: boolean; isLatam: boolean; confidence: number } {
  const combined = texts.join(' ').toLowerCase()
  if (!combined.trim()) return { isSpanish: false, isPeninsular: false, isLatam: false, confidence: 0 }

  // Common Spanish words detection
  const spanishWords = ['de', 'la', 'el', 'en', 'los', 'las', 'del', 'con', 'para', 'por', 'una', 'uno',
    'que', 'es', 'se', 'como', 'más', 'pero', 'sus', 'este', 'esta', 'estos', 'estas',
    'hay', 'también', 'muy', 'todo', 'ya', 'mi', 'me', 'te', 'nos', 'les', 'hoy', 'nuevo', 'nueva']

  const words = combined.split(/\s+/)
  const spanishWordCount = words.filter(w => spanishWords.includes(w)).length
  const spanishRatio = words.length > 0 ? spanishWordCount / words.length : 0
  const isSpanish = spanishRatio > 0.08 || spanishWordCount >= 3

  const peninsularFound = containsAny(combined, PENINSULAR_MARKERS)
  const latamFound = containsAny(combined, LATAM_MARKERS)

  const isPeninsular = peninsularFound.length > 0
  const isLatam = latamFound.length > 0 && peninsularFound.length === 0

  let confidence = 0
  if (isSpanish) confidence = Math.min(0.5 + spanishRatio, 0.8)
  if (isPeninsular) confidence = Math.min(confidence + 0.2, 1.0)

  return { isSpanish, isPeninsular, isLatam, confidence }
}

// ============ MAIN FUNCTION ============

export function calculateSpainFit(input: SpainFitInput): SpainFitResult {
  const components = {
    languageScore: calculateLanguageScore(input),
    locationScore: calculateLocationScore(input),
    timezoneScore: calculateTimezoneScore(input),
    hashtagsScore: calculateHashtagsScore(input),
    brandsScore: calculateBrandsScore(input),
    audienceScore: calculateAudienceScore(input),
  }

  // Weighted average
  const weights = {
    languageScore: 0.25,
    locationScore: 0.25,
    timezoneScore: 0.15,
    hashtagsScore: 0.15,
    brandsScore: 0.10,
    audienceScore: 0.10,
  }

  let totalScore = 0
  let totalInferred = 0
  let totalComponents = 0

  for (const [key, weight] of Object.entries(weights)) {
    const comp = components[key as keyof typeof components]
    totalScore += comp.score * weight
    if (comp.isInferred) totalInferred++
    totalComponents++
  }

  const score = Math.round(Math.min(100, Math.max(0, totalScore)))

  // Determine level
  let level: SpainFitResult['level']
  if (score >= 80) level = 'confirmed'
  else if (score >= 60) level = 'probable'
  else if (score >= 40) level = 'partial'
  else if (score >= 20) level = 'hispanic_global'
  else {
    // Check if it's latam vs unknown
    const langResult = detectSpanishLanguage([
      input.bio || '',
      ...(input.captions || []),
    ])
    level = langResult.isLatam ? 'latam' : 'unknown'
  }

  // Signal color
  let signal: SpainFitResult['signal']
  if (score >= 70) signal = 'green'
  else if (score >= 40) signal = 'yellow'
  else if (score >= 15) signal = 'red'
  else signal = 'gray'

  // Confidence based on how many components are inferred vs observed
  const confidence = Math.max(0.1, 1 - (totalInferred / totalComponents) * 0.5)

  // Detect city/province from location component
  const locationInfo = detectCityProvince(input)

  // Build explanation
  const explanation = buildExplanation(level, score, components, locationInfo)

  return {
    score,
    level,
    signal,
    explanation,
    components,
    detectedCity: locationInfo.city,
    detectedProvince: locationInfo.province,
    confidence: Math.round(confidence * 100) / 100,
  }
}

// ============ COMPONENT CALCULATORS ============

function calculateLanguageScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  const texts = [
    input.bio || '',
    ...(input.captions || []),
  ].filter(Boolean)

  if (texts.length === 0) {
    return { score: 0, detail: 'Sin datos de texto', isInferred: true }
  }

  const result = detectSpanishLanguage(texts)

  if (!result.isSpanish) {
    // Check if language field says Spanish
    if (input.language?.toLowerCase().startsWith('es') || input.language?.toLowerCase() === 'spanish') {
      return { score: 40, detail: 'Idioma marcado como español pero sin textos detectados', isInferred: true }
    }
    return { score: 0, detail: 'No se detecta español en bio/captions', isInferred: true }
  }

  if (result.isPeninsular) {
    return { score: 95, detail: 'Español peninsular detectado (vocabulario de España)', isInferred: false }
  }

  if (result.isLatam) {
    return { score: 30, detail: 'Español LATAM detectado (vocabulario latinoamericano)', isInferred: false }
  }

  // Generic Spanish
  if (input.language?.toLowerCase().startsWith('es')) {
    return { score: 55, detail: 'Español genérico + campo idioma confirma', isInferred: false }
  }

  return { score: 50, detail: 'Español detectado sin marcadores regionales claros', isInferred: true }
}

function calculateLocationScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  // Check country field
  const country = (input.country || '').toLowerCase().trim()
  if (['spain', 'españa', 'espana', 'es'].includes(country)) {
    return { score: 100, detail: `País: ${input.country}`, isInferred: false }
  }

  // Check for LATAM countries explicitly
  const latamCountries = ['mexico', 'méxico', 'colombia', 'argentina', 'chile', 'peru', 'perú',
    'venezuela', 'ecuador', 'guatemala', 'cuba', 'bolivia', 'honduras', 'el salvador',
    'paraguay', 'uruguay', 'costa rica', 'panama', 'panamá', 'nicaragua', 'puerto rico',
    'república dominicana', 'dominicana', 'mx', 'co', 'ar', 'cl', 'pe', 've']
  if (latamCountries.includes(country)) {
    return { score: 5, detail: `País LATAM: ${input.country}`, isInferred: false }
  }

  // Check city field
  const city = (input.city || '').toLowerCase().trim()
  if (city && SPANISH_CITIES[city]) {
    return { score: 95, detail: `Ciudad española: ${input.city}`, isInferred: false }
  }

  // Check bio for Spanish cities and provinces
  const bio = (input.bio || '').toLowerCase()
  const normalizedBio = normalizeText(input.bio || '')

  // Check for Spain flag emoji
  if ((input.bio || '').includes('🇪🇸')) {
    return { score: 85, detail: 'Bandera española 🇪🇸 en bio', isInferred: false }
  }

  // Check bio for city mentions
  for (const [cityName, province] of Object.entries(SPANISH_CITIES)) {
    if (bio.includes(cityName) || normalizedBio.includes(normalizeText(cityName))) {
      return { score: 80, detail: `Ciudad "${cityName}" mencionada en bio (${province})`, isInferred: true }
    }
  }

  // Check bio for province mentions
  for (const prov of SPAIN_PROVINCES) {
    if (bio.includes(prov) || normalizedBio.includes(normalizeText(prov))) {
      return { score: 75, detail: `Provincia "${prov}" mencionada en bio`, isInferred: true }
    }
  }

  // Check for "españa" or "spain" in bio
  if (bio.includes('españa') || bio.includes('spain') || normalizedBio.includes('espana')) {
    return { score: 85, detail: '"España/Spain" mencionado en bio', isInferred: true }
  }

  return { score: 0, detail: 'Sin señales de ubicación en España', isInferred: true }
}

function calculateTimezoneScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  const timestamps = input.postTimestamps
  if (!timestamps || timestamps.length < 3) {
    return { score: 0, detail: 'Insuficientes timestamps para análisis de zona horaria', isInferred: true }
  }

  // Analyze posting hours in CET (UTC+1 / UTC+2 in summer)
  // Use UTC+1 as baseline for CET
  let cetActive = 0 // Posts between 8:00-23:00 CET
  let cetSleep = 0  // Posts between 2:00-7:00 CET (unlikely for Spain)
  let total = 0

  for (const ts of timestamps) {
    const date = new Date(ts)
    if (isNaN(date.getTime())) continue

    // Convert to CET (UTC+1). Approximate; doesn't handle DST perfectly but good enough.
    const cetHour = (date.getUTCHours() + 1) % 24
    total++

    if (cetHour >= 8 && cetHour <= 23) {
      cetActive++
    } else if (cetHour >= 2 && cetHour <= 7) {
      cetSleep++
    }
  }

  if (total === 0) {
    return { score: 0, detail: 'Sin timestamps válidos', isInferred: true }
  }

  const activeRatio = cetActive / total
  const sleepRatio = cetSleep / total

  // If most posts are during Spanish active hours
  if (activeRatio > 0.7) {
    return { score: 85, detail: `${Math.round(activeRatio * 100)}% posts en horario activo CET (8:00-23:00)`, isInferred: true }
  }

  if (activeRatio > 0.5) {
    return { score: 55, detail: `${Math.round(activeRatio * 100)}% posts en horario CET`, isInferred: true }
  }

  // If many posts during CET sleep hours -> likely Americas timezone
  if (sleepRatio > 0.3) {
    return { score: 15, detail: `${Math.round(sleepRatio * 100)}% posts en madrugada CET, posible zona horaria de Américas`, isInferred: true }
  }

  return { score: 35, detail: 'Patrón de horas de publicación no concluyente', isInferred: true }
}

function calculateHashtagsScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  const hashtags = (input.hashtags || []).map(h => h.toLowerCase())
  if (hashtags.length === 0) {
    return { score: 0, detail: 'Sin hashtags para analizar', isInferred: true }
  }

  // Check for Spain-specific hashtags
  const spainMatches: string[] = []
  for (const tag of hashtags) {
    const normalizedTag = tag.startsWith('#') ? tag : `#${tag}`
    if (SPAIN_HASHTAGS.some(st => normalizedTag.includes(st.replace('#', '')))) {
      spainMatches.push(normalizedTag)
    }
  }

  // Check for category-specific Spanish hashtags
  const categoryMatches: string[] = []
  for (const cat of SPAIN_CATEGORIES) {
    for (const catTag of cat.hashtagsEs) {
      const normalizedCatTag = catTag.toLowerCase().replace('#', '')
      if (hashtags.some(h => h.replace('#', '') === normalizedCatTag)) {
        categoryMatches.push(catTag)
      }
    }
  }

  const totalMatches = spainMatches.length + categoryMatches.length
  if (totalMatches === 0) {
    return { score: 10, detail: 'Sin hashtags españoles detectados', isInferred: true }
  }

  if (spainMatches.length > 0) {
    const score = Math.min(95, 60 + spainMatches.length * 10)
    return { score, detail: `Hashtags España: ${spainMatches.slice(0, 3).join(', ')}`, isInferred: false }
  }

  // Only category matches (could be from any Spanish-speaking country)
  const score = Math.min(60, 25 + categoryMatches.length * 8)
  return { score, detail: `Hashtags categoría ES: ${categoryMatches.slice(0, 3).join(', ')}`, isInferred: true }
}

function calculateBrandsScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  const allText = [
    ...(input.captions || []),
    ...(input.mentions || []),
    input.bio || '',
  ].join(' ').toLowerCase()

  if (!allText.trim()) {
    return { score: 0, detail: 'Sin datos para detección de marcas', isInferred: true }
  }

  // Collect all Spanish brands from categories
  const allBrands: string[] = []
  for (const cat of SPAIN_CATEGORIES) {
    allBrands.push(...cat.brandsEs)
  }
  const uniqueBrands = [...new Set(allBrands)]

  const foundBrands: string[] = []
  for (const brand of uniqueBrands) {
    if (allText.includes(brand.toLowerCase())) {
      foundBrands.push(brand)
    }
  }

  if (foundBrands.length === 0) {
    return { score: 0, detail: 'Sin menciones a marcas españolas', isInferred: true }
  }

  // Spanish-only brands are stronger signals
  const spanishOnlyBrands = ['Mercadona', 'KH-7', 'Don Limpio', 'Cecotec', 'Freshly Cosmetics',
    'Primor', 'Druni', 'PcComponentes', 'Wallapop', 'Civitatis', 'Heura',
    'El Pozo', 'Bosque Verde', 'Deliplus', 'SEAT', 'Cupra', 'Mahou',
    'Estrella Damm', 'Ruavieja', 'Isdin', 'Sesderma', 'Heliocare']

  const spanishOnlyFound = foundBrands.filter(b =>
    spanishOnlyBrands.some(sob => sob.toLowerCase() === b.toLowerCase())
  )

  if (spanishOnlyFound.length > 0) {
    const score = Math.min(95, 70 + spanishOnlyFound.length * 10)
    return { score, detail: `Marcas españolas: ${spanishOnlyFound.slice(0, 3).join(', ')}`, isInferred: false }
  }

  // International brands present in Spain
  const score = Math.min(50, 20 + foundBrands.length * 5)
  return { score, detail: `Marcas presentes en ES: ${foundBrands.slice(0, 3).join(', ')}`, isInferred: true }
}

function calculateAudienceScore(input: SpainFitInput): { score: number; detail: string; isInferred: boolean } {
  const comments = input.comments || []
  if (comments.length < 5) {
    return { score: 0, detail: 'Insuficientes comentarios para análisis de audiencia', isInferred: true }
  }

  const langResult = detectSpanishLanguage(comments)

  if (!langResult.isSpanish) {
    return { score: 10, detail: 'Audiencia no hispanohablante', isInferred: true }
  }

  if (langResult.isPeninsular) {
    return { score: 90, detail: 'Comentarios con vocabulario peninsular', isInferred: true }
  }

  if (langResult.isLatam) {
    return { score: 25, detail: 'Comentarios con vocabulario LATAM', isInferred: true }
  }

  return { score: 45, detail: 'Audiencia hispanohablante (origen no determinado)', isInferred: true }
}

// ============ UTILITIES ============

function detectCityProvince(input: SpainFitInput): { city?: string; province?: string } {
  // Check city field directly
  const city = (input.city || '').toLowerCase().trim()
  if (city && SPANISH_CITIES[city]) {
    return { city: input.city || undefined, province: SPANISH_CITIES[city] }
  }

  // Check bio
  const bio = (input.bio || '').toLowerCase()
  for (const [cityName, province] of Object.entries(SPANISH_CITIES)) {
    if (bio.includes(cityName)) {
      return { city: cityName, province }
    }
  }

  return {}
}

function buildExplanation(
  level: SpainFitResult['level'],
  score: number,
  components: SpainFitResult['components'],
  locationInfo: { city?: string; province?: string }
): string {
  const parts: string[] = []

  switch (level) {
    case 'confirmed':
      parts.push(`Creador confirmado en España (${score}/100).`)
      break
    case 'probable':
      parts.push(`Probable creador español (${score}/100).`)
      break
    case 'partial':
      parts.push(`Señales parciales de España (${score}/100).`)
      break
    case 'hispanic_global':
      parts.push(`Creador hispano global, no confirmado ES (${score}/100).`)
      break
    case 'latam':
      parts.push(`Indicadores de LATAM, no de España (${score}/100).`)
      break
    default:
      parts.push(`Sin datos suficientes para clasificar (${score}/100).`)
  }

  if (locationInfo.city) {
    parts.push(`Ubicación: ${locationInfo.city}${locationInfo.province ? ` (${locationInfo.province})` : ''}.`)
  }

  // Add top component details
  const sorted = Object.entries(components)
    .sort(([, a], [, b]) => b.score - a.score)
    .filter(([, v]) => v.score > 0)
    .slice(0, 2)

  for (const [, comp] of sorted) {
    parts.push(comp.detail + '.')
  }

  return parts.join(' ')
}

// Rule-based sentiment analyzer for comments (English + Spanish)
// No external API dependencies required

const POSITIVE_WORDS = new Set([
  // English
  'love', 'amazing', 'incredible', 'perfect', 'beautiful', 'wonderful', 'fantastic',
  'awesome', 'great', 'excellent', 'brilliant', 'outstanding', 'superb', 'gorgeous',
  'stunning', 'magnificent', 'lovely', 'adorable', 'blessed', 'grateful', 'thankful',
  'inspiring', 'impressive', 'happy', 'best', 'favorite', 'favourite', 'recommend',
  'obsessed', 'fire', 'goals', 'queen', 'king', 'slay', 'iconic',
  'wow', 'bravo', 'top', 'yes',
  // Spanish
  'encanta', 'increíble', 'increible', 'perfecto', 'perfecta', 'genial', 'maravilloso',
  'maravillosa', 'precioso', 'preciosa', 'hermoso', 'hermosa', 'bonito', 'bonita',
  'guapo', 'guapa', 'divino', 'divina', 'espectacular', 'fantástico', 'fantastico',
  'fantástica', 'fantastica', 'excelente', 'brillante', 'impresionante', 'magnífico',
  'magnifico', 'estupendo', 'estupenda', 'brutal', 'tremendo', 'tremenda',
  'inspirador', 'inspiradora', 'feliz', 'mejor', 'favorito', 'favorita',
  'recomiendo', 'crack', 'oleee', 'ole', 'mola', 'flipante',
])

const NEGATIVE_WORDS = new Set([
  // English
  'hate', 'ugly', 'terrible', 'bad', 'worst', 'horrible', 'awful', 'disgusting',
  'pathetic', 'trash', 'garbage', 'waste', 'boring', 'disappointing', 'disappointed',
  'scam', 'fake', 'fraud', 'spam', 'clickbait', 'cringe', 'overrated', 'overhyped',
  'annoying', 'stupid', 'dumb', 'lame', 'gross', 'nasty', 'toxic', 'useless',
  'misleading', 'ripoff', 'unfollow',
  // Spanish
  'odio', 'feo', 'fea', 'terrible', 'malo', 'mala', 'peor', 'horrible', 'espantoso',
  'espantosa', 'asqueroso', 'asquerosa', 'patético', 'patetico', 'patética', 'patetica',
  'basura', 'porquería', 'porqueria', 'estafa', 'fraude', 'spam', 'aburrido', 'aburrida',
  'decepcionante', 'decepcionado', 'decepcionada', 'pérdida', 'perdida',
  'timo', 'engaño', 'engano', 'mentira', 'falso', 'falsa', 'cutre', 'ridículo',
  'ridiculo', 'ridícula', 'ridicula', 'vergüenza', 'verguenza', 'asco',
])

// Positive phrases (multi-word)
const POSITIVE_PHRASES = [
  'me encanta', 'me gusta', 'qué bonito', 'que bonito', 'qué bonita', 'que bonita',
  'lo amo', 'lo necesito', 'so good', 'so beautiful', 'well done', 'love this',
  'love it', 'so cute', 'i need this', 'take my money', 'qué hermoso', 'que hermoso',
  'qué lindo', 'que lindo', 'qué precioso', 'que precioso',
]

// Negative phrases (multi-word)
const NEGATIVE_PHRASES = [
  'no me gusta', 'qué asco', 'que asco', 'qué feo', 'que feo', 'qué horror',
  'que horror', 'so bad', 'so ugly', 'waste of time', 'waste of money',
  'pérdida de tiempo', 'perdida de tiempo', 'no vale', 'do not buy', 'don\'t buy',
  'not worth', 'no lo recomiendo', 'no recomiendo',
]

export interface SentimentResult {
  sentiment: 'positive' | 'negative' | 'neutral'
  score: number // -1 to 1
}

export function analyzeSentiment(text: string): SentimentResult {
  if (!text || text.trim().length === 0) {
    return { sentiment: 'neutral', score: 0 }
  }

  const lower = text.toLowerCase()

  let positiveCount = 0
  let negativeCount = 0

  // Check multi-word phrases first
  for (const phrase of POSITIVE_PHRASES) {
    if (lower.includes(phrase)) positiveCount += 2 // Phrases weigh more
  }
  for (const phrase of NEGATIVE_PHRASES) {
    if (lower.includes(phrase)) negativeCount += 2
  }

  // Check individual words
  const words = lower.replace(/[^\w\sáéíóúñü]/g, ' ').split(/\s+/).filter(Boolean)
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) positiveCount++
    if (NEGATIVE_WORDS.has(word)) negativeCount++
  }

  // Check for emoji sentiment boosters
  const positiveEmojis = (text.match(/[❤️💕💖💗💓💞💘😍🥰😻👏🔥✨🎉🙌💯👍🤩😊💪🏆⭐🌟]/gu) || []).length
  const negativeEmojis = (text.match(/[😡🤬👎💩🤮😤😠🖕😒😞😢😭]/gu) || []).length
  positiveCount += positiveEmojis
  negativeCount += negativeEmojis

  const total = positiveCount + negativeCount
  if (total === 0) {
    return { sentiment: 'neutral', score: 0 }
  }

  // Normalize score to -1 to 1
  const rawScore = (positiveCount - negativeCount) / total
  const score = Math.max(-1, Math.min(1, rawScore))

  let sentiment: 'positive' | 'negative' | 'neutral'
  if (score > 0.1) {
    sentiment = 'positive'
  } else if (score < -0.1) {
    sentiment = 'negative'
  } else {
    sentiment = 'neutral'
  }

  return { sentiment, score: parseFloat(score.toFixed(3)) }
}

export interface BulkSentimentResult {
  positive: number
  negative: number
  neutral: number
  avgScore: number
}

export function analyzeBulkSentiments(
  comments: { text: string }[]
): BulkSentimentResult {
  if (!comments || comments.length === 0) {
    return { positive: 0, negative: 0, neutral: 0, avgScore: 0 }
  }

  let positive = 0
  let negative = 0
  let neutral = 0
  let totalScore = 0

  for (const comment of comments) {
    const result = analyzeSentiment(comment.text)
    totalScore += result.score
    if (result.sentiment === 'positive') positive++
    else if (result.sentiment === 'negative') negative++
    else neutral++
  }

  return {
    positive,
    negative,
    neutral,
    avgScore: parseFloat((totalScore / comments.length).toFixed(3)),
  }
}

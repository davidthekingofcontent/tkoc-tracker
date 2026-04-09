import { prisma } from '@/lib/db'

export interface SpainCategoryDef {
  slug: string
  nameEs: string
  nameEn: string
  parentSlug: string
  keywords: string[]
  hashtagsEs: string[]
  brandsEs: string[]
}

export const SPAIN_CATEGORIES: SpainCategoryDef[] = [
  // ===== HOGAR & FAMILIA =====
  {
    slug: 'limpieza-hogar',
    nameEs: 'Limpieza del Hogar',
    nameEn: 'Home Cleaning',
    parentSlug: 'hogar-familia',
    keywords: ['limpieza', 'cleaning', 'limpiar', 'hogar limpio', 'fregar', 'barrer', 'aspirar', 'desinfectar'],
    hashtagsEs: ['#limpieza', '#limpiezahogar', '#cleaningtiktok', '#trucosdeLimpieza', '#limpiezaprofunda', '#hogarorganizado'],
    brandsEs: ['Vileda', 'KH-7', 'Fairy', 'Don Limpio', 'Cif', 'Scotch-Brite', 'Bona', 'Bosque Verde'],
  },
  {
    slug: 'cocina-recetas',
    nameEs: 'Cocina y Recetas',
    nameEn: 'Cooking & Recipes',
    parentSlug: 'hogar-familia',
    keywords: ['receta', 'cocina', 'recipe', 'cooking', 'cocinar', 'guiso', 'horno', 'sarten', 'plato'],
    hashtagsEs: ['#recetas', '#cocina', '#recetasfaciles', '#cocinaespañola', '#recetascaseras', '#cocinaencasa'],
    brandsEs: ['Thermomix', 'Lidl', 'Mercadona', 'El Pozo', 'Gallo', 'Carbonell', 'Gallina Blanca', 'Maggi'],
  },
  {
    slug: 'organizacion-hogar',
    nameEs: 'Organización del Hogar',
    nameEn: 'Home Organization',
    parentSlug: 'hogar-familia',
    keywords: ['organizar', 'orden', 'organization', 'declutter', 'almacenaje', 'armario', 'ordenar'],
    hashtagsEs: ['#organizacion', '#ordenencasa', '#homeorganization', '#organizar', '#trucoshogar'],
    brandsEs: ['IKEA', 'Leroy Merlin', 'Zara Home', 'Tiger', 'Primark Home'],
  },
  {
    slug: 'decoracion',
    nameEs: 'Decoración',
    nameEn: 'Home Decor',
    parentSlug: 'hogar-familia',
    keywords: ['decoracion', 'decor', 'interiorismo', 'deco', 'decorar', 'salon', 'dormitorio', 'estilo nordico'],
    hashtagsEs: ['#decoracion', '#homedecor', '#interiorismo', '#decohogar', '#casabonita'],
    brandsEs: ['IKEA', 'Zara Home', 'Maisons du Monde', 'Westwing', 'Kave Home', 'El Corte Inglés'],
  },
  {
    slug: 'bricolaje',
    nameEs: 'Bricolaje y DIY',
    nameEn: 'DIY & Home Improvement',
    parentSlug: 'hogar-familia',
    keywords: ['bricolaje', 'diy', 'manualidades', 'pintar', 'reformar', 'herramientas', 'carpinteria'],
    hashtagsEs: ['#bricolaje', '#diy', '#manualidades', '#hazlotumismo', '#reforma'],
    brandsEs: ['Leroy Merlin', 'Bricomart', 'Bosch', 'AKI', 'Dremel'],
  },
  {
    slug: 'electrodomesticos',
    nameEs: 'Electrodomésticos',
    nameEn: 'Home Appliances',
    parentSlug: 'hogar-familia',
    keywords: ['electrodomestico', 'aspirador', 'lavadora', 'robot cocina', 'freidora aire', 'airfryer'],
    hashtagsEs: ['#electrodomesticos', '#airfryer', '#robotcocina', '#aspiradorrobot'],
    brandsEs: ['Cecotec', 'Xiaomi', 'Dyson', 'Rowenta', 'Bosch', 'Samsung', 'LG', 'Taurus'],
  },
  {
    slug: 'maternidad',
    nameEs: 'Maternidad y Crianza',
    nameEn: 'Parenting & Motherhood',
    parentSlug: 'hogar-familia',
    keywords: ['maternidad', 'bebe', 'embarazo', 'crianza', 'mama', 'niños', 'pañales', 'lactancia'],
    hashtagsEs: ['#maternidad', '#mamaprimeriza', '#crianzarespetuosa', '#embarazo', '#bebé', '#vidademama'],
    brandsEs: ['Dodot', 'Chicco', 'Mustela', 'Suavinex', 'Hero Baby', 'Nutriben'],
  },

  // ===== LIFESTYLE =====
  {
    slug: 'moda',
    nameEs: 'Moda',
    nameEn: 'Fashion',
    parentSlug: 'lifestyle',
    keywords: ['moda', 'fashion', 'outfit', 'look', 'estilismo', 'ropa', 'tendencia', 'ootd'],
    hashtagsEs: ['#moda', '#modaespañola', '#outfit', '#lookdeldia', '#ootd', '#styleinspo'],
    brandsEs: ['Zara', 'Mango', 'Bershka', 'Pull&Bear', 'Massimo Dutti', 'Stradivarius', 'Parfois'],
  },
  {
    slug: 'belleza',
    nameEs: 'Belleza y Cosmética',
    nameEn: 'Beauty & Cosmetics',
    parentSlug: 'lifestyle',
    keywords: ['belleza', 'beauty', 'maquillaje', 'skincare', 'makeup', 'piel', 'crema', 'serum', 'cosmetica'],
    hashtagsEs: ['#belleza', '#maquillaje', '#skincare', '#rutinabelleza', '#beauty', '#cuidadodelapiel'],
    brandsEs: ['Freshly Cosmetics', 'Garnier', 'Nivea', 'Sephora', 'Primor', 'Mercadona Deliplus', 'Druni'],
  },
  {
    slug: 'fitness',
    nameEs: 'Fitness y Deporte',
    nameEn: 'Fitness & Sports',
    parentSlug: 'lifestyle',
    keywords: ['fitness', 'gym', 'gimnasio', 'entreno', 'entrenamiento', 'deporte', 'crossfit', 'running'],
    hashtagsEs: ['#fitness', '#fitnessmotivation', '#entreno', '#gimnasio', '#vidasana', '#deporte'],
    brandsEs: ['Prozis', 'MyProtein', 'Decathlon', 'Reebok', 'Nike', 'Adidas', 'Sprinter'],
  },
  {
    slug: 'wellness',
    nameEs: 'Bienestar y Salud Mental',
    nameEn: 'Wellness & Mental Health',
    parentSlug: 'lifestyle',
    keywords: ['bienestar', 'wellness', 'meditacion', 'mindfulness', 'salud mental', 'yoga', 'autocuidado'],
    hashtagsEs: ['#bienestar', '#saludmental', '#mindfulness', '#meditacion', '#autocuidado'],
    brandsEs: ['Headspace', 'Calm', 'Rituals', 'Natura Bissé'],
  },
  {
    slug: 'viajes',
    nameEs: 'Viajes',
    nameEn: 'Travel',
    parentSlug: 'lifestyle',
    keywords: ['viaje', 'travel', 'viajar', 'escapada', 'turismo', 'ruta', 'hotel', 'destino'],
    hashtagsEs: ['#viajes', '#viajar', '#travel', '#españa', '#turismo', '#escapada', '#viajeros'],
    brandsEs: ['Booking', 'Iberia', 'Vueling', 'Renfe', 'Airbnb', 'Civitatis'],
  },
  {
    slug: 'lifestyle-familiar',
    nameEs: 'Lifestyle Familiar',
    nameEn: 'Family Lifestyle',
    parentSlug: 'lifestyle',
    keywords: ['familia', 'family', 'vida familiar', 'padres', 'hijos', 'plan familiar', 'fin de semana'],
    hashtagsEs: ['#familia', '#vidafamiliar', '#planenfamilia', '#familytime'],
    brandsEs: ['Disney', 'Imaginarium', 'Toys R Us', 'Parque Warner', 'PortAventura'],
  },

  // ===== CONSUMO =====
  {
    slug: 'supermercado',
    nameEs: 'Supermercado y Compras',
    nameEn: 'Grocery & Shopping',
    parentSlug: 'consumo',
    keywords: ['supermercado', 'compra', 'mercadona', 'lidl', 'oferta', 'ahorro', 'precio', 'cesta'],
    hashtagsEs: ['#mercadona', '#lidl', '#compras', '#supermercado', '#ahorro', '#haul'],
    brandsEs: ['Mercadona', 'Lidl', 'Carrefour', 'Aldi', 'Dia', 'Alcampo', 'Bon Preu'],
  },
  {
    slug: 'farmacia',
    nameEs: 'Farmacia y Parafarmacia',
    nameEn: 'Pharmacy & Health',
    parentSlug: 'consumo',
    keywords: ['farmacia', 'parafarmacia', 'crema', 'proteccion solar', 'vitaminas', 'cuidado personal'],
    hashtagsEs: ['#farmacia', '#parafarmacia', '#cosmeticafarmacia', '#skincarefarmacia'],
    brandsEs: ['CeraVe', 'La Roche-Posay', 'Isdin', 'Avene', 'Sesderma', 'Bioderma', 'Heliocare'],
  },
  {
    slug: 'tecnologia',
    nameEs: 'Tecnología',
    nameEn: 'Technology',
    parentSlug: 'consumo',
    keywords: ['tech', 'tecnologia', 'gadget', 'movil', 'ordenador', 'smartphone', 'tablet', 'review'],
    hashtagsEs: ['#tech', '#tecnologia', '#review', '#gadgets', '#smartphone'],
    brandsEs: ['Apple', 'Samsung', 'Xiaomi', 'PcComponentes', 'MediaMarkt', 'Amazon'],
  },
  {
    slug: 'motor',
    nameEs: 'Motor y Automoción',
    nameEn: 'Automotive',
    parentSlug: 'consumo',
    keywords: ['coche', 'motor', 'auto', 'conducir', 'electrico', 'suv', 'gasolina'],
    hashtagsEs: ['#motor', '#coches', '#automocion', '#cocheelectrico', '#conducir'],
    brandsEs: ['SEAT', 'Cupra', 'Renault', 'Hyundai', 'Tesla', 'Toyota', 'Peugeot'],
  },
  {
    slug: 'mascotas',
    nameEs: 'Mascotas',
    nameEn: 'Pets',
    parentSlug: 'consumo',
    keywords: ['mascota', 'perro', 'gato', 'pet', 'dog', 'cat', 'cachorro', 'veterinario'],
    hashtagsEs: ['#mascotas', '#perrosdeinstagram', '#gatosdeinstagram', '#pets', '#doglovers'],
    brandsEs: ['Royal Canin', 'Purina', 'Tiendanimal', 'Kiwoko', 'Advance'],
  },

  // ===== PROFESIONAL =====
  {
    slug: 'emprendedores',
    nameEs: 'Emprendimiento y Negocios',
    nameEn: 'Entrepreneurship & Business',
    parentSlug: 'profesional',
    keywords: ['emprender', 'negocio', 'startup', 'empresa', 'emprendedor', 'autonomo', 'freelance'],
    hashtagsEs: ['#emprender', '#emprendedores', '#negocio', '#startup', '#autonomos'],
    brandsEs: ['Holded', 'Factorial', 'Shopify', 'Stripe'],
  },
  {
    slug: 'educacion',
    nameEs: 'Educación y Formación',
    nameEn: 'Education & Training',
    parentSlug: 'profesional',
    keywords: ['educacion', 'formacion', 'curso', 'aprender', 'estudiar', 'oposiciones', 'universidad'],
    hashtagsEs: ['#educacion', '#formacion', '#oposiciones', '#estudiar', '#cursosonline'],
    brandsEs: ['Platzi', 'Domestika', 'Coursera', 'Udemy', 'UNIR'],
  },
  {
    slug: 'finanzas-personales',
    nameEs: 'Finanzas Personales',
    nameEn: 'Personal Finance',
    parentSlug: 'profesional',
    keywords: ['finanzas', 'ahorro', 'inversion', 'dinero', 'invertir', 'bolsa', 'cripto', 'hipoteca'],
    hashtagsEs: ['#finanzaspersonales', '#ahorro', '#inversion', '#dinero', '#libertadfinanciera'],
    brandsEs: ['Trade Republic', 'Revolut', 'N26', 'Indexa Capital', 'MyInvestor'],
  },
  {
    slug: 'marketing-digital',
    nameEs: 'Marketing Digital',
    nameEn: 'Digital Marketing',
    parentSlug: 'profesional',
    keywords: ['marketing', 'redes sociales', 'social media', 'seo', 'contenido', 'community manager'],
    hashtagsEs: ['#marketingdigital', '#socialmedia', '#redessociales', '#communitymanager'],
    brandsEs: ['Metricool', 'Canva', 'Hootsuite', 'HubSpot', 'Semrush'],
  },
  {
    slug: 'derecho-legal',
    nameEs: 'Derecho y Legal',
    nameEn: 'Law & Legal',
    parentSlug: 'profesional',
    keywords: ['abogado', 'derecho', 'legal', 'ley', 'contrato', 'laboral', 'fiscal', 'autonomo'],
    hashtagsEs: ['#derecho', '#abogado', '#legal', '#derecholaboral', '#autonomos'],
    brandsEs: ['Legálitas', 'Wolters Kluwer'],
  },

  // ===== ENTRETENIMIENTO =====
  {
    slug: 'futbol',
    nameEs: 'Fútbol',
    nameEn: 'Football / Soccer',
    parentSlug: 'entretenimiento',
    keywords: ['futbol', 'football', 'liga', 'gol', 'champions', 'laliga', 'seleccion', 'madrid', 'barça'],
    hashtagsEs: ['#futbol', '#laliga', '#realmadrid', '#fcbarcelona', '#seleccionespañola'],
    brandsEs: ['LaLiga', 'Movistar Plus', 'DAZN', 'Nike', 'Adidas', 'Puma'],
  },
  {
    slug: 'gaming',
    nameEs: 'Gaming y Videojuegos',
    nameEn: 'Gaming',
    parentSlug: 'entretenimiento',
    keywords: ['gaming', 'videojuego', 'gamer', 'playstation', 'xbox', 'fortnite', 'twitch', 'stream'],
    hashtagsEs: ['#gaming', '#gamer', '#videojuegos', '#twitch', '#ps5', '#xbox'],
    brandsEs: ['PlayStation', 'Xbox', 'Nintendo', 'Razer', 'GAME', 'PcComponentes'],
  },
  {
    slug: 'humor',
    nameEs: 'Humor y Comedia',
    nameEn: 'Humor & Comedy',
    parentSlug: 'entretenimiento',
    keywords: ['humor', 'comedia', 'risa', 'chiste', 'meme', 'sketch', 'parodia', 'gracioso'],
    hashtagsEs: ['#humor', '#comedia', '#risas', '#memes', '#sketch', '#viral'],
    brandsEs: [],
  },
  {
    slug: 'musica',
    nameEs: 'Música',
    nameEn: 'Music',
    parentSlug: 'entretenimiento',
    keywords: ['musica', 'music', 'cancion', 'cantante', 'concierto', 'spotify', 'reggaeton'],
    hashtagsEs: ['#musica', '#music', '#spotify', '#concierto', '#nuevamusica'],
    brandsEs: ['Spotify', 'Apple Music', 'Live Nation', 'Primavera Sound', 'Sonar'],
  },
  {
    slug: 'cine-series',
    nameEs: 'Cine y Series',
    nameEn: 'Movies & TV Shows',
    parentSlug: 'entretenimiento',
    keywords: ['cine', 'serie', 'pelicula', 'netflix', 'estreno', 'actor', 'film', 'tvseries'],
    hashtagsEs: ['#cine', '#series', '#netflix', '#peliculas', '#estrenos'],
    brandsEs: ['Netflix', 'HBO Max', 'Disney+', 'Movistar Plus', 'Amazon Prime Video', 'Filmin'],
  },

  // ===== FOOD & DRINK =====
  {
    slug: 'restaurantes',
    nameEs: 'Restaurantes y Gastronomía',
    nameEn: 'Restaurants & Gastronomy',
    parentSlug: 'food-drink',
    keywords: ['restaurante', 'gastro', 'gastronomia', 'bar', 'tapas', 'cena', 'brunch', 'terraza'],
    hashtagsEs: ['#restaurante', '#gastronomia', '#foodie', '#tapas', '#dondecomer'],
    brandsEs: ['TheFork', 'ElTenedor', 'Just Eat', 'Glovo', 'Uber Eats'],
  },
  {
    slug: 'nutricion',
    nameEs: 'Nutrición y Dieta',
    nameEn: 'Nutrition & Diet',
    parentSlug: 'food-drink',
    keywords: ['nutricion', 'dieta', 'saludable', 'healthy', 'proteina', 'calorias', 'vegano', 'realfooding'],
    hashtagsEs: ['#nutricion', '#realfooding', '#comidaSaludable', '#dieta', '#healthy'],
    brandsEs: ['Heura', 'Prozis', 'HSN', 'Veritas', 'Naturitas'],
  },
  {
    slug: 'vinos-bebidas',
    nameEs: 'Vinos y Bebidas',
    nameEn: 'Wine & Beverages',
    parentSlug: 'food-drink',
    keywords: ['vino', 'wine', 'cerveza', 'beer', 'cocktail', 'gin', 'cava', 'bodega', 'vermut'],
    hashtagsEs: ['#vino', '#wine', '#cerveza', '#cava', '#winelover', '#vermut'],
    brandsEs: ['Mahou', 'Estrella Damm', 'Freixenet', 'Codorniu', 'Ruavieja', 'Alhambra'],
  },
  {
    slug: 'coffee',
    nameEs: 'Café y Cafeterías',
    nameEn: 'Coffee & Cafes',
    parentSlug: 'food-drink',
    keywords: ['cafe', 'coffee', 'cafeteria', 'barista', 'latte', 'espresso', 'cafetera'],
    hashtagsEs: ['#cafe', '#coffee', '#cafeteria', '#coffeelover', '#cafedespecialidad'],
    brandsEs: ['Nespresso', 'Dolce Gusto', 'Starbucks', 'Tim Hortons', 'La Marzocco'],
  },
]

/**
 * Seeds all Spain categories into the database using upsert.
 * Safe to run multiple times.
 */
export async function seedSpainCategories(): Promise<{ created: number; updated: number }> {
  let created = 0
  let updated = 0

  for (const cat of SPAIN_CATEGORIES) {
    const existing = await prisma.spainCategory.findUnique({ where: { slug: cat.slug } })

    await prisma.spainCategory.upsert({
      where: { slug: cat.slug },
      update: {
        nameEs: cat.nameEs,
        nameEn: cat.nameEn,
        parentSlug: cat.parentSlug,
        keywords: cat.keywords,
        hashtagsEs: cat.hashtagsEs,
        brandsEs: cat.brandsEs,
      },
      create: {
        slug: cat.slug,
        nameEs: cat.nameEs,
        nameEn: cat.nameEn,
        parentSlug: cat.parentSlug,
        keywords: cat.keywords,
        hashtagsEs: cat.hashtagsEs,
        brandsEs: cat.brandsEs,
      },
    })

    if (existing) {
      updated++
    } else {
      created++
    }
  }

  return { created, updated }
}

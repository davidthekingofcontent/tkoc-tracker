// Loaded before every db test file: the database under test must be the local throwaway one.
const url = process.env.DATABASE_URL || ''
if (!/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1):\d+\//.test(url)) {
  throw new Error('Refusing to run database tests: DATABASE_URL is not a local database')
}

// A module of its own, so its `url` never clashes with the other guard when the tests are type-checked together
export {}

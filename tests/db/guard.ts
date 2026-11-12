// Loaded before every db test file: the database under test must be the local throwaway one.
const url = process.env.DATABASE_URL || ''
if (!/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1):\d+\//.test(url)) {
  throw new Error('Refusing to run database tests: DATABASE_URL is not a local database')
}

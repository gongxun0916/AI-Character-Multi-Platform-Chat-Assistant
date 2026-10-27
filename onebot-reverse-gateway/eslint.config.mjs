import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**'] },
  ...tseslint.configs.recommended,
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } }
)

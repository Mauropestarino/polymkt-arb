# Security Policy

## Sensitive data

Do not commit live credentials, private keys, wallet exports, or local runtime data.

Examples of sensitive data for this project:

- `.env`
- `PRIVATE_KEY`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- wallet backup files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`
- generated trading logs in `data/`

Use [`.env.example`](/C:/Users/pesta/OneDrive/Escritorio/polymarket/.env.example) as the public template and keep real secrets only in local environment files or GitHub repository secrets.

## Before pushing

Run:

```bash
npm run security:check
```

This checks for:

- tracked `.env` files
- common secret patterns in the working tree
- accidental inclusion of local data artifacts

## If a secret is exposed

1. Rotate the exposed key immediately.
2. Revoke and recreate any affected Polymarket API credentials.
3. Replace the compromised private key or funder account if necessary.
4. Remove the secret from git history before publishing the repository.

## Reporting

If you find a security issue in this repository, avoid posting the secret publicly. Share only sanitized details.

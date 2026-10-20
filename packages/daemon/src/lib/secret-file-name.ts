export function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx|tfstate|tfvars)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower) ||
    ['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.htpasswd', '.pgpass'].includes(lower) ||
    /(secret|credential|service-?account|token)[^.]*(\.(json|ya?ml|ini|conf|cfg|toml|txt|xml|properties))?$/.test(
      lower
    )
  );
}

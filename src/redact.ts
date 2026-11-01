export function redact(value: string): string {
  return makeRedactor()(value);
}

export function makeRedactor(): (value: string) => string {
  const secrets = Object.entries(process.env)
    .filter(
      ([name, secret]) =>
        secret &&
        secret.length >= 8 &&
        /TOKEN|SECRET|PASSWORD|AUTH_URL|JWT|PRIVATE_KEY/i.test(name),
    )
    .map(([, secret]) => secret!);
  return (value) => {
    let safe = value
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
      .replace(/force:\/\/[^\s]+/gi, "[REDACTED Salesforce authorization URL]");
    for (const secret of secrets) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe;
  };
}

// Utils: Mask phone and email values for safe logging.
export const maskPhone = (phone?: string | null): string => {
  if (!phone) return "N/A";
  const trimmed = phone.toString().trim();
  if (trimmed.length <= 4) return "****";
  return "****" + trimmed.slice(-4);
};

export const maskEmail = (email?: string | null): string => {
  if (!email) return "N/A";
  const trimmed = email.toString().trim();
  const [local, domain] = trimmed.split("@");
  if (!domain) return "***@***";
  if (local.length <= 1) return `*...@${domain}`;
  return `${local[0]}***@${domain}`;
};

const time = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

const date = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short",
});

export function formatTime(value: string) {
  return time.format(new Date(value));
}

export function formatDate(value: string) {
  return date.format(new Date(value));
}

const reminderDeliveriesInFlight = new Map<string, Promise<unknown>>();

export function isReminderDeliveryInFlight(reminderId: string): boolean {
  return reminderDeliveriesInFlight.has(reminderId);
}

export function claimReminderDelivery(reminderId: string, delivery: Promise<unknown>): void {
  reminderDeliveriesInFlight.set(reminderId, delivery);
  const release = () => {
    if (reminderDeliveriesInFlight.get(reminderId) === delivery) {
      reminderDeliveriesInFlight.delete(reminderId);
    }
  };
  delivery.then(release, release);
}

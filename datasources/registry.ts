import type { DataSourceDriver, DriverRegistry } from "./contracts.ts";

export function createDriverRegistry(): DriverRegistry {
  const drivers = new Map<string, DataSourceDriver>();
  return {
    register: (driver) => { drivers.set(driver.id, driver); },
    get: (id) => drivers.get(id) ?? null,
    list: () => [...drivers.values()],
  };
}

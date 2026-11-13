// The phone layout: below 1024 px (phones and narrow windows) the dashboard has a top line and a bottom bar with four
// tabs instead of the header; see "The phone" in DESIGN.md.
import { useEffect, useState } from "react";

export const PHONE = "(max-width: 1023.98px)";

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia !== "undefined" && matchMedia(PHONE).matches);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const f = () => setPhone(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return phone;
}

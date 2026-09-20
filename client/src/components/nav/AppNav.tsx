import { NavLink, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Money" },
];

export function AppNav() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      // Drop every cached query result so a shared machine's next signed-in
      // user never briefly sees the previous user's dashboard data before
      // the first refetch completes.
      queryClient.clear();
      // Always redirect, even if the network call failed — a signed-out user
      // stuck on a page that will just 401 on every subsequent action helps
      // no one.
      navigate("/login");
    }
  }

  return (
    <nav>
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}>
          {item.label}
        </NavLink>
      ))}
      <button onClick={signOut}>Sign out</button>
    </nav>
  );
}

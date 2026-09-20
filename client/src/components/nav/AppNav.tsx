import { NavLink, useNavigate } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Money" },
];

export function AppNav() {
  const navigate = useNavigate();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
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

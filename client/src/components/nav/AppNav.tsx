import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Money" },
];

export function AppNav() {
  return (
    <nav>
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

import React from 'react'
import ReactDOM from 'react-dom/client'

function App() {
  return (
    <div>
      <h1>Accommerce Inventory</h1>
      <p>Welcome to the inventory management system</p>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

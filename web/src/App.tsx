import { Button, Result, Spin } from 'antd';
import { useEffect } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import { AppLayout } from './layouts/AppLayout';
import { ClientDetailPage } from './pages/clients/ClientDetailPage';
import { ClientsPage } from './pages/clients/ClientsPage';
import { HomePage } from './pages/HomePage';
import { InvoicesPage } from './pages/invoices/InvoicesPage';
import { LoginPage } from './pages/LoginPage';
import { MockMailboxPage } from './pages/mockMailbox/MockMailboxPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { LoginRoute, MockOnly, RequireAuth, SetupRoute } from './routes/guards';
import { useSession } from './stores/session';

/** Carga el estado de la sesión antes de mostrar cualquier pantalla. */
function Bootstrap() {
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const bootstrap = useSession((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === 'loading') return <Spin fullscreen />;
  if (status === 'error') {
    return (
      <Result
        status="error"
        title="No se pudo cargar Aldebaran"
        subTitle={error}
        extra={<Button onClick={() => void bootstrap()}>Reintentar</Button>}
      />
    );
  }
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Bootstrap />,
    children: [
      { path: '/setup', element: <SetupRoute><SetupPage /></SetupRoute> },
      { path: '/login', element: <LoginRoute><LoginPage /></LoginRoute> },
      {
        path: '/',
        element: <RequireAuth><AppLayout /></RequireAuth>,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'clientes', element: <ClientsPage /> },
          { path: 'clientes/:id', element: <ClientDetailPage /> },
          { path: 'productos', element: <ProductsPage /> },
          { path: 'facturas', element: <InvoicesPage /> },
          { path: 'casilla-simulada', element: <MockOnly><MockMailboxPage /></MockOnly> },
          { path: 'configuracion', element: <SettingsPage /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}

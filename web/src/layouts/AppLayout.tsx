import { AppstoreOutlined, FileTextOutlined, HomeOutlined, MailOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons';
import { Layout, Menu } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router';
import styled from 'styled-components';
import { AppHeader } from '../components/AppHeader';
import { useSession } from '../stores/session';

const Content = styled(Layout.Content)`
  padding: 24px;
`;

const MENU_ITEMS = [
  { key: '/', icon: <HomeOutlined />, label: 'Inicio' },
  { key: '/clientes', icon: <TeamOutlined />, label: 'Clientes' },
  { key: '/productos', icon: <AppstoreOutlined />, label: 'Productos' },
  { key: '/facturas', icon: <FileTextOutlined />, label: 'Facturas' },
  { key: '/configuracion', icon: <SettingOutlined />, label: 'Configuración' },
];

/** Layout de las pantallas con sesión: header, menú lateral y contenido. */
export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const mockMode = useSession((s) => s.appInfo?.mockMode ?? false);
  // RF-204: la casilla simulada solo existe en modo mock.
  const items = mockMode
    ? [...MENU_ITEMS.slice(0, -1), { key: '/casilla-simulada', icon: <MailOutlined />, label: 'Casilla simulada' }, MENU_ITEMS.at(-1)!]
    : MENU_ITEMS;
  // /clientes/12 marca "Clientes" en el menú.
  const section = `/${pathname.split('/')[1] ?? ''}`;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppHeader />
      <Layout>
        <Layout.Sider breakpoint="lg" collapsedWidth={0} theme="light" width={220}>
          <Menu
            mode="inline"
            selectedKeys={[section]}
            items={items}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Layout.Sider>
        <Content>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

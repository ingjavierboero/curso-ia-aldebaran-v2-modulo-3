import { AppstoreOutlined, HomeOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons';
import { Layout, Menu } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router';
import styled from 'styled-components';
import { AppHeader } from '../components/AppHeader';

const Content = styled(Layout.Content)`
  padding: 24px;
`;

const MENU_ITEMS = [
  { key: '/', icon: <HomeOutlined />, label: 'Inicio' },
  { key: '/clientes', icon: <TeamOutlined />, label: 'Clientes' },
  { key: '/productos', icon: <AppstoreOutlined />, label: 'Productos' },
  { key: '/configuracion', icon: <SettingOutlined />, label: 'Configuración' },
];

/** Layout de las pantallas con sesión: header, menú lateral y contenido. */
export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
            items={MENU_ITEMS}
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

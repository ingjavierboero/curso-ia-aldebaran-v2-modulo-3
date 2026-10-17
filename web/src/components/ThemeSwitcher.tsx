import { DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { Button, Dropdown, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { useResolvedTheme, useTheme, type ThemePreference } from '../stores/theme';

const OPTIONS: { key: ThemePreference; label: string; icon: ReactNode }[] = [
  { key: 'light', label: 'Claro', icon: <SunOutlined /> },
  { key: 'dark', label: 'Oscuro', icon: <MoonOutlined /> },
  { key: 'system', label: 'Usar el del sistema', icon: <DesktopOutlined /> },
];

/** RNF-15: selector de tema del header. */
export function ThemeSwitcher() {
  const preference = useTheme((s) => s.preference);
  const setPreference = useTheme((s) => s.setPreference);
  const resolved = useResolvedTheme();

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: OPTIONS,
        selectable: true,
        selectedKeys: [preference],
        onClick: ({ key }) => setPreference(key as ThemePreference),
      }}
    >
      <Tooltip title="Tema" placement="bottom">
        <Button
          type="text"
          aria-label="Cambiar tema"
          icon={resolved === 'dark' ? <MoonOutlined /> : <SunOutlined />}
          style={{ color: '#fff' }}
        />
      </Tooltip>
    </Dropdown>
  );
}

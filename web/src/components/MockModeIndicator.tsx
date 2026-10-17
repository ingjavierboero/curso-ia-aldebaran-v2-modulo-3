import { ExperimentOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { useSession } from '../stores/session';

export const MOCK_MODE_LABEL = 'Modo mock: ARCA, LLM y email simulados';

/** RF-209: indicador visible en el header de todas las pantallas en modo mock. */
export function MockModeIndicator() {
  const mockMode = useSession((s) => s.appInfo?.mockMode ?? false);
  if (!mockMode) return null;

  return (
    <Tag color="orange" icon={<ExperimentOutlined />} style={{ marginInlineEnd: 0 }}>
      {MOCK_MODE_LABEL}
    </Tag>
  );
}

import { Button, Popconfirm, Tooltip } from 'antd';
import { useState, type ReactNode } from 'react';

interface Props {
  /** Texto del tooltip y nombre accesible del botón. */
  label: string;
  icon: ReactNode;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  /** Si se indica, pide confirmación con este texto antes de ejecutar la acción. */
  confirm?: string;
}

/** Acción de una fila de tabla: botón con ícono, tooltip y confirmación opcional. */
export function TableAction({ label, icon, onClick, danger, confirm }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const button = (
    <Button
      type="text"
      size="small"
      danger={danger}
      icon={icon}
      aria-label={label}
      onClick={confirm ? undefined : onClick}
    />
  );

  // Mientras la confirmación está abierta, el tooltip se oculta para no taparla.
  // El span corta la propagación para que el click no dispare el de la fila; también
  // cubre los clicks en la confirmación, que React propaga aunque esté en un portal.
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Tooltip title={label} open={confirmOpen ? false : undefined}>
        {confirm ? (
          <Popconfirm
            title={confirm}
            okText="Sí"
            cancelText="No"
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            onConfirm={onClick}
          >
            {button}
          </Popconfirm>
        ) : (
          button
        )}
      </Tooltip>
    </span>
  );
}

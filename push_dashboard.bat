@echo off
REM push_dashboard.bat
REM Solo hace git add/commit/push del dashboard CE-Retention. NO trae datos
REM nuevos de HubSpot/Metabase — eso lo hace la tarea programada de Claude,
REM que corre antes (miércoles 8:30 AM) y deja los archivos ya actualizados
REM en esta carpeta. Este .bat corre un rato después (sugerido: 8:45 AM) via
REM el Programador de tareas de Windows, para publicar esos cambios en
REM GitHub sin depender de que ninguna sesión de Claude esté abierta en ese
REM momento exacto.

cd /d "C:\Users\jesus\Documents\dashboard\ce-retention-soporte-ops"

git add -A
git commit -m "Actualizacion automatica dashboard - %date% %time%"

if errorlevel 1 (
  echo [push_dashboard] No hay cambios nuevos para commitear ^(la tarea de Claude no corrio o no encontro cambios^).
) else (
  git push origin master
  echo [push_dashboard] Push completado.
)

export function canViewDashboard(user) {
  if(!user||user.isActive===false||user.is_active===false)return false;
  if(user.role==='admin')return true;
  if(user.role!=='accounting')return false;
  return (user.canViewDashboard??user.can_view_dashboard??true)===true;
}

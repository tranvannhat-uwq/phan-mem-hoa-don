export function isActiveUser(user) {
  return Boolean(user) && user.isActive !== false && user.is_active !== false;
}

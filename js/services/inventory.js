import { state } from '../state.js';
import { isCloudActive, supabaseClient } from './supabase.js?v=20261016-modal-viewport-v1';
import { createInventoryGateway } from '../domain/inventory.js?v=20261016-modal-viewport-v1';

export const inventoryGateway = createInventoryGateway({
  scope: () => state.currentUser && ['admin', 'accounting'].includes(state.currentUser.role)
    ? `${state.currentUser.authUserId || state.currentUser.id}:${state.currentUser.role}` : '',
  rpc: async (name, args) => {
    if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để sử dụng kho.');
    const { data, error } = await supabaseClient.rpc(name, args);
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') throw new Error(name === 'rpc_inventory_set_sync'
        ? 'Cloud chưa có bản cập nhật bật/tắt đồng bộ kho 0089.' : 'Cloud chưa có bản cập nhật quản lý kho 0088.');
      const failure = new Error(error.message || 'Không thể thực hiện thao tác kho.');
      failure.definitive = /^(?:PGRST\d+|[A-Z0-9]{5})$/.test(error.code || '');
      throw failure;
    }
    return data;
  }
});

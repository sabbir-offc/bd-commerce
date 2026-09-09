/** Raw wire shapes for the Steadfast (Packzy) merchant API. */

export interface SteadfastEnvelope {
  /** Steadfast repeats an HTTP-like code inside the body. 200 means success. */
  status: number
  message?: string
}

export interface SteadfastConsignment {
  consignment_id: number
  invoice: string
  tracking_code: string
  recipient_name: string
  recipient_phone: string
  recipient_address: string
  cod_amount: number
  status: string
  note: string | null
  created_at?: string
  updated_at?: string
}

export interface SteadfastCreateOrderResponse extends SteadfastEnvelope {
  consignment: SteadfastConsignment
}

/** Bulk rows carry their own outcome; there is no envelope around the array. */
export interface SteadfastBulkRow {
  invoice: string
  recipient_name?: string
  recipient_phone?: string
  recipient_address?: string
  cod_amount?: number
  note?: string | null
  consignment_id?: number
  tracking_code?: string
  status: string
}

export interface SteadfastStatusResponse extends SteadfastEnvelope {
  delivery_status: string
}

export interface SteadfastBalanceResponse extends SteadfastEnvelope {
  current_balance: number
}

/** Every delivery_status Steadfast documents, for exhaustive mapping. */
export type SteadfastDeliveryStatus =
  | 'pending'
  | 'delivered_approval_pending'
  | 'partial_delivered_approval_pending'
  | 'cancelled_approval_pending'
  | 'unknown_approval_pending'
  | 'delivered'
  | 'partial_delivered'
  | 'cancelled'
  | 'hold'
  | 'in_review'
  | 'unknown'

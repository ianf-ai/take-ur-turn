/** Additive input facts shared by transport and persisted run metadata. */
export type InvocationInput={kind:'none'}|{kind:'stdin';encoding:'utf8';text:string};
export type InputDelivery={status:'pending'|'complete'|'failed';bytes:number;error?:string};
export function validInputDelivery(value:unknown):value is InputDelivery {
 const v=value as InputDelivery;
 return !!v&&['pending','complete','failed'].includes(v.status)&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<=65536&&(v.status!=='failed'||typeof v.error==='string'&&v.error.length>0);
}

/*
  Normalize an interface schema against a dialect type registry.

  Shared by SchemaWorker.standardize and e9core sqlite-ddl so printed DDL
  matches live deploy.
*/

export const defaultStandardColumn = {
  name: '',
  type: '',
  length: null,
  nullable: true,
  default_value: undefined,
  auto_increment: false
};

export function standardizeSchema(schema, dialect) {
  const standardSchema = structuredClone(schema);
  const invalidTables = [];
  standardSchema.tables = (standardSchema.tables || [])
    .map((table) => {
      const invalidColumns = [];
      const columns = table.columns || [];
      table.columns = Object.keys(columns)
        .map((key) => {
          let col = columns[key];
          if (typeof col === 'string') col = { type: col };
          let name = key;
          if (Array.isArray(columns)) name = col.name;
          if (col.column_type) {
            invalidColumns.push({ ...col, name, error: 'column_type is reserved for sql dialect' });
          }
          const typeDetails = dialect.getType(col.type) || {};
          try {
            return {
              ...defaultStandardColumn,
              ...typeDetails,
              ...col,
              name
            };
          } catch (e) {
            invalidColumns.push({ ...col, name, error: e.message });
            return null;
          }
        })
        .filter(Boolean);
      if (invalidColumns.length > 0) {
        invalidTables.push({ ...table }, { invalidColumns });
        return false;
      }
      table.indexes = (table.indexes || []).map((d) => ({
        columns: typeof d.columns === 'string' ? d.columns.split(',').map((x) => x.trim()) : d.columns,
        primary: d.primary || false,
        unique: d.unique || d.primary || false
      }));
      return table;
    })
    .filter(Boolean);
  if (invalidTables.length > 0) {
    throw new Error('Invalid table definitions: ' + invalidTables.map((d) => JSON.stringify(d)));
  }
  return standardSchema;
}

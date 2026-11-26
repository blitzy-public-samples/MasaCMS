component extends="mura.bean.beanORM" table="tfixture" entityname="fixture" displayName="fixtureBean" orderby="name" {
	// ORM entity sample whose declaration follows a UTF-8 byte-order mark
	property name="fixtureid" fieldtype="id";
	property name="site" fieldtype="many-to-one" cfc="site" fkcolumn="siteid";
	property name="name" datatype="varchar" length="100";
}
